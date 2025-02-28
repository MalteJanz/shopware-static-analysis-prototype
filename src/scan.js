import Parser, {Query} from 'tree-sitter';
import TreeSitterPhp from 'tree-sitter-php';
import TreeSitterTypescript from 'tree-sitter-typescript';
import {globbyStream} from 'globby';
import * as fs from "node:fs";
import * as path from "node:path";

// setup tree-sitter parser for PHP
const Php = TreeSitterPhp.php;
const TypeScript = TreeSitterTypescript.typescript;
const parser = new Parser();
parser.setLanguage(Php);
const parseOptions = {
    // fixes invalid argument error for parser.parse(...) with big strings
    // likely needs to be larger than the biggest file
    bufferSize: 1024 * 1024, // 1MiB
}

// tree-sitter queries
// these have their own "query language", think of them like SQL or RegEx but for
// tree-sitter syntax trees.
// Documentation: https://tree-sitter.github.io/tree-sitter/using-parsers/queries/index.html
//
// A good place to start is playing with them in the "playground"
// https://tree-sitter.github.io/tree-sitter/7-playground.html
const classDefinitionQuery = new Query(Php, `(
  (namespace_definition
    name: (namespace_name) @namespace
  )
  (comment)? @comment
  (class_declaration 
    attributes: 
      (attribute_list
        (attribute_group 
          (attribute (name) @name
            (#eq? @name "Package")
            parameters:
            (arguments 
              (argument 
                (string
                  (string_content) @package
                )
              )
            )
          )
        )
      )
    (final_modifier)? @finalkeyword
    name: (name) @classname
  )
)`);
const frontendDefinitionQuery = new Query(TypeScript, `(program 
   (comment) @comment
)`);

/**
 * Data storage for efficient class lookup by full name (including namespace).
 *
 * @typedef Definitions {Map<string, {
 *    isInternal: boolean,
 *    isFinal: boolean,
 *    namespace: string,
 *    className: string,
 *    fileName: string,
 *    domain: string | undefined
 * }>}
 */

function queryClassDefinitions(tree, globPath, filePath, resultMap) {
    const queryCaptures = classDefinitionQuery.captures(tree.rootNode);

    const isFinalKeyword = !!queryCaptures.find(c => c.name === 'finalkeyword');
    const namespace = queryCaptures.find(c => c.name === 'namespace')?.node?.text;
    const className = queryCaptures.find(c => c.name === 'classname')?.node?.text;
    const package_domain = queryCaptures.find(c => c.name === 'package')?.node?.text;
    const comments = queryCaptures.filter(c => c.name === 'comment');
    const isInternal = comments.some(c => c.node.text.includes('@internal'));
    const isFinalComment = comments.some(c => c.node.text.includes('@final'));

    if (!namespace || !className) return;

    resultMap.set(`${namespace}\\${className}`, {
        isInternal,
        isFinal: isFinalKeyword || isFinalComment,
        namespace,
        className,
        fileName: globPath,
        domain: package_domain,
    });
}

function queryFrontendDefinitions(tree, globPath, filePath, resultMap) {
    const queryCaptures = frontendDefinitionQuery.captures(tree.rootNode);

    const topLevelComments = queryCaptures.filter(c => c.name === 'comment');
    const isInternal = topLevelComments.some(c =>
        c.node.text.includes('@internal') ||
        c.node.text.includes('@private'
        ));

    const domainRegex = /@sw-package ([a-zA-Z-@]+)/;
    const domain = topLevelComments.map(c => c.node.text.match(domainRegex))
        .find(match => match)?.[1] || null;

    resultMap.set(filePath, {
        isInternal,
        isFinal: null,
        namespace: null,
        className: null,
        fileName: globPath,
        domain,
    });
}

async function scanFiles(dir, callback) {
    const paths = globbyStream([
        '**/*.php',
        '**/*.{j,t}s',
        '!**/*.spec.{j,t}s',
        '!**/{T,t}est{,s}/**/*', // exclude any test directories
        '!**/node_modules/**/*', // just to be safe (globby already respects .gitignore files)
        '!**/vendor/**/*'
    ], {
        gitignore: true,
        cwd: dir,
    });

    for await (const p of paths) {
        const fullPath = path.join(dir, p);
        fs.readFile(fullPath, 'utf-8', (err, data) => {
            if (err) {
                console.error(err);
                return;
            }

            callback(p, fullPath, data);
        });
    }
}

async function scan(pathToScan) {
    console.log('scanning', pathToScan)
    console.log('scanning files, this might take a few seconds...');

    let phpFileCount = 0;
    let frontendFileCount = 0;
    /** @type {Definitions} */
    const classDefinitions = new Map();
    await scanFiles(pathToScan, (globPath, filePath, content) => {
        try {
            const filetype = path.extname(filePath);

            if (filetype === '.php') {
                parser.setLanguage(Php);
                const tree = parser.parse(content, undefined, parseOptions);
                queryClassDefinitions(tree, globPath, filePath, classDefinitions);
                phpFileCount++;
            } else if (['.js', '.ts'].includes(filetype)) {
                parser.setLanguage(TypeScript);
                const tree = parser.parse(content, undefined, parseOptions);
                queryFrontendDefinitions(tree, globPath, filePath, classDefinitions);
                frontendFileCount++;
            }
        } catch (error) {
            console.error(`Error parsing ${filePath}`, error);
            process.exit(1);
        }
    });
    console.log('scanned files:', phpFileCount + frontendFileCount);
    console.log('scanned PHP files:', phpFileCount);
    console.log('scanned JS/TS files:', frontendFileCount);
    console.log('found classes:', classDefinitions.size);

    return {classDefinitions};
}

const cacheFilePath = "./out/scan-cache.json";

function loadCache() {
    try {
        const cacheFile = fs.readFileSync(cacheFilePath, "utf8");
        console.log("Found cached scan results. Remove this file if you want to rescan source files:", cacheFilePath);
        const data = JSON.parse(cacheFile);
        return {
            classDefinitions: new Map(data.classDefinitions),
        };
    } catch (e) {
        return null;
    }
}

function saveCache(classDefinitions) {
    fs.writeFileSync(cacheFilePath, JSON.stringify({
        classDefinitions: Array.from(classDefinitions.entries()),
    }));
    console.log("Cache saved to", cacheFilePath);
}

/**
 * @param {string} pathToScan
 * @returns {Promise<{classDefinitions: Definitions}>}
 */
export async function getClassData(pathToScan) {
    const cachedData = loadCache();
    if (cachedData) return cachedData;

    const scanData = await scan(pathToScan);
    saveCache(scanData.classDefinitions);
    return scanData;
}
