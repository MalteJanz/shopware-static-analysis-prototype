import Parser, {Query} from 'tree-sitter';
import TreeSitterPhp from 'tree-sitter-php';
import {globbyStream} from 'globby';
import * as fs from "node:fs";
import * as path from "node:path";

// setup tree-sitter parser for PHP
const Php = TreeSitterPhp.php;
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
//
// Note: This query is very simple and doesn't catch usages of classes in the same namespace!
const useQuery = new Query(Php, `(qualified_name) @type`);

// They can also get quite complicated just as SQL Queries :p
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
    name: (name) @classname
  )
)`);

/**
 * Data storage for efficient used class lookup by full name (including namespace).
 * The value are all files in which the class is used.
 *
 * @typedef ClassUsages {Map<string, string[]>}
 */

/**
 * Data storage for efficient class lookup by full name (including namespace).
 *
 * @typedef ClassDefinitions {Map<string, {
 *    isInternal: boolean,
 *    namespace: string,
 *    className: string,
 *    fileName: string,
 *    domain: string | undefined
 * }>}
 */

function queryClassUsages(tree, filename, resultMap) {
    const queryCaptures = useQuery.captures(tree.rootNode);
    const uses = queryCaptures.map(c => c.node.text);

    uses.forEach(u => {
        if (!resultMap.has(u)) {
            resultMap.set(u, []);
        }

        resultMap.get(u).push(filename);
    });
}

function queryClassDefinitions(tree, fileName, resultMap) {
    const queryCaptures = classDefinitionQuery.captures(tree.rootNode);

    const comments = queryCaptures.filter(c => c.name === 'comment');
    const isInternal = comments.some(c => c.node.text.includes('@internal'));
    const namespace = queryCaptures.find(c => c.name === 'namespace')?.node?.text;
    const className = queryCaptures.find(c => c.name === 'classname')?.node?.text;
    const package_domain = queryCaptures.find(c => c.name === 'package')?.node?.text;

    if (!namespace || !className) return;

    resultMap.set(`${namespace}\\${className}`, {
        isInternal,
        namespace,
        className,
        fileName,
        domain: package_domain,
    });
}

async function scanFiles(dir, callback) {
    const paths = globbyStream([
        '**/*.php',
        '!**/{T,t}est{,s}/**/*.php', // exclude any test directories
        '!**/node_modules/**/*.php', // just to be safe (globby already respects .gitignore files)
        '!**/vendor/**/*.php'
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

            callback(fullPath, data);
        });
    }
}

async function scan(pathToScan) {
    console.log('scanning', pathToScan)
    console.log('scanning files, this might take a few seconds...');

    let fileCount = 0;
    /** @type {ClassUsages} */
    const classUsages = new Map();
    /** @type {ClassDefinitions} */
    const classDefinitions = new Map();
    await scanFiles(pathToScan, (filename, content) => {
        try {
            const tree = parser.parse(content, undefined, parseOptions);
            fileCount++;
            queryClassDefinitions(tree, filename, classDefinitions);
            queryClassUsages(tree, filename, classUsages);
        } catch (error) {
            console.error(`Error parsing ${filename}`, error);
            process.exit(1);
        }
    });
    console.log('scanned files:', fileCount);
    console.log('found classes:', classDefinitions.size);
    console.log('found class usages:', classUsages.size);

    return {classUsages, classDefinitions};
}

const cacheFilePath = "./out/scan-cache.json";

function loadCache() {
    try {
        const cacheFile = fs.readFileSync(cacheFilePath, "utf8");
        console.log("Found cached scan results. Remove this file if you want to rescan source files:", cacheFilePath);
        const data = JSON.parse(cacheFile);
        return {
            classUsages: new Map(data.classUsages),
            classDefinitions: new Map(data.classDefinitions),
        };
    } catch (e) {
        return null;
    }
}

function saveCache(classUsages, classDefinitions) {
    fs.writeFileSync(cacheFilePath, JSON.stringify({
        classUsages: Array.from(classUsages.entries()),
        classDefinitions: Array.from(classDefinitions.entries()),
    }));
    console.log("Cache saved to", cacheFilePath);
}

/**
 * @param {string} pathToScan
 * @returns {Promise<{classUsages: ClassUsages, classDefinitions: ClassDefinitions}>}
 */
export async function getClassData(pathToScan) {
    const cachedData = loadCache();
    if (cachedData) return cachedData;

    const scanData = await scan(pathToScan);
    saveCache(scanData.classUsages, scanData.classDefinitions);
    return scanData;
}
