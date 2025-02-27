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

// ToDo: The above useQuery misses types from the same namespace
// This query tries to capture also all Classnames (that aren't fully qualified / use statements) in a file, but
// it needs further processing in JS to actually combine the results properly
const useQueryAdvanced = new Query(Php, `[
(namespace_definition
  name: (namespace_name) @class_namespace
)
(qualified_name
  (name) @use_class
) @use_namespace
(named_type) @type
(object_creation_expression
  (name) @type
)
(scoped_call_expression
  scope: (name) @type
)
(class_constant_access_expression
  .(name) @type
)
]`);

/**
 * Data storage for efficient used class lookup by full name (including namespace).
 * The value are all files in which the class is used.
 *
 * @type {Map<string, string[]>}
 */
const classUsages = new Map();

/**
 * Data storage for efficient class lookup by full name (including namespace).
 *
 * @type {Map<string, {
 *    isInternal: boolean,
 *    namespace: string,
 *    className: string,
 *    fileName: string,
 *    domain: string | undefined
 * }>}
 */
const classDefinitions = new Map();

function queryClassUsages(tree, filename) {
    const queryCaptures = useQuery.captures(tree.rootNode);
    const uses = queryCaptures.map(c => c.node.text);

    uses.forEach(u => {
        if (!classUsages.has(u)) {
            classUsages.set(u, []);
        }

        classUsages.get(u).push(filename);
    });
}

function queryClassDefinitions(tree, fileName) {
    const queryCaptures = classDefinitionQuery.captures(tree.rootNode);

    const comments = queryCaptures.filter(c => c.name === 'comment');
    const isInternal = comments.some(c => c.node.text.includes('@internal'));
    const namespace = queryCaptures.find(c => c.name === 'namespace')?.node?.text;
    const className = queryCaptures.find(c => c.name === 'classname')?.node?.text;
    const package_domain = queryCaptures.find(c => c.name === 'package')?.node?.text;

    if (!namespace || !className) return;

    classDefinitions.set(`${namespace}\\${className}`, {
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

// -------------------------------
// ---------- MAIN LOGIC----------
// -------------------------------

// Todo: one nice optimization would be to cache the results to disk and reuse them between runs
// So you can focus on analyzing the data and building the visualization

const pathToScan = process.argv[2];
if (!pathToScan) {
    console.error('please provide a filepath to scan as an argument');
    process.exit(1);
}

console.log('scanning', pathToScan)
console.log('scanning files, this might take a few seconds...');
let fileCount = 0;
await scanFiles(pathToScan, (filename, content) => {
    try {
        const tree = parser.parse(content, undefined, parseOptions);
        fileCount++;
        queryClassDefinitions(tree, filename);
        queryClassUsages(tree, filename);
    } catch (error) {
        console.error(`Error parsing ${filename}`, error);
        process.exit(1);
    }
});

console.log('scanned files:', fileCount);
console.log('found classes:', classDefinitions.size);
console.log('found class usages:', classUsages.size);

// sort by most used
const sortedByUsageCount = [...classUsages.entries()].sort((a, b) => b[1].length - a[1].length);

// This template was generated with the help of ChatGPT :D
const htmlReport = `<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>SW Architecture Report</title>
    <style>
        body { 
            font-family: Arial, sans-serif; 
            margin: 20px; 
            background-color: #121212; 
            color: #e0e0e0; 
        }
        table { 
            width: 100%; 
            border-collapse: collapse; 
            margin-top: 20px; 
            background-color: #1e1e1e; 
        }
        th, td { 
            border: 1px solid #333; 
            padding: 8px; 
            text-align: left; 
            vertical-align: top;
        }
        th { 
            background-color: #333; 
            color: #ffffff; 
        }
        .collapsible { 
            cursor: pointer; 
            background-color: #2c2c2c; 
            border: none; 
            padding: 8px; 
            width: 100%; 
            text-align: left; 
            color: #ffffff; 
        }
        .content { 
            display: none; 
            padding: 8px; 
            border-top: 1px solid #444; 
            background-color: #252525; 
        }
    </style>
    <script>
        function toggleCollapse(id) {
            const content = document.getElementById(id);
            if (content.style.display === "none" || content.style.display === "") {
                content.style.display = "block";
            } else {
                content.style.display = "none";
            }
        }
    </script>
</head>
<body>
    <h1>Shopware Architecture Report</h1>
    <table>
        <thead>
            <tr>
                <th>Uses Found</th>
                <th>Classname</th>
                <th>Domain</th>
                <th>Is Internal</th>
            </tr>
        </thead>
        <tbody>
            ${sortedByUsageCount.map(([classname, usages], index) => {
    const classInfo = classDefinitions.get(classname) || {};
    return `
                <tr>
                    <td>${usages.length}</td>
                    <td>
                        <button class="collapsible" onclick="toggleCollapse('content-${index}')">${classname}</button>
                        <div id="content-${index}" class="content">
                            <ul>
                                ${usages.map(file => `<li>${file}</li>`).join('')}
                            </ul>
                        </div>
                    </td>
                    <td>${classInfo.domain || 'N/A'}</td>
                    <td>${classInfo.isInternal ? 'Yes' : 'No'}</td>
                </tr>`;
}).join('')}
        </tbody>
    </table>
</body>
</html>`;

try {
    const reportPath = './out/sw-architecture-report.html';
    fs.writeFileSync(reportPath, htmlReport);
    console.log("html report written to", reportPath);
} catch (err) {
    console.error(err);
}
