import {getClassData} from "./scan.js";
import * as fs from "node:fs";

const pathToScan = process.argv[2];
if (!pathToScan) {
    console.error('please provide a filepath to scan as an argument');
    process.exit(1);
}

const {classDefinitions} = await getClassData(pathToScan);

// sort by namespace
const fileSortedByNamespace = [...classDefinitions.entries()].sort((a, b) => {
    const aString = (a[1].namespace || a[1].fileName).toLowerCase();
    const bString = (b[1].namespace || b[1].fileName).toLowerCase();

    return aString.localeCompare(bString);
});

const domainBuckets = [...classDefinitions.entries()].reduce((acc, [filename, classInfo]) => {
    if (!acc.has(classInfo.domain)) {
        acc.set(classInfo.domain, []);
    }

    acc.get(classInfo.domain).push(filename);
    return acc;
}, new Map()).entries().toArray();
domainBuckets.sort((a, b) => b[1].length - a[1].length);


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
        
        .not-internal {
            background-color: #585858;
        }
        
        .domain-framework, .domain-fundamentals--framework {
            background-color: blue;
        }
        .domain-inventory {
            background-color: green;
        }
        .domain-discovery, .domain-fundamentals--discovery {
            background-color: orange;
        }
        .domain-checkout {
            background-color: darkcyan;
        }
        .domain-after-sales, .domain-fundamentals--after-sales {
            background-color: red;
        }
        .domain-data-services {
            background-color: purple;
        }
        .domain-innovation {
            background-color: purple;
        }
    </style>
</head>
<body>
    <h1>Shopware domain split report</h1>
    <h2>Summary</h2>
    <table>
        <thead>
            <tr>
                <th>Domain</th>
                <th>File count</th>
                <th>Percentage</th>
            </tr>
        </thead>
        <tbody>
            ${domainBuckets.map(([domain, classList]) => `
                <tr>
                    <td class="domain-${(domain || 'unknown').replace('@', '--')}">${domain || 'unknown'}</td>
                    <td>${classList.length}</td>
                    <td>${(classList.length / fileSortedByNamespace.length * 100.0).toFixed(2)}%</td>
                </tr>`).join('')}
        </tbody>
    </table>
    
    <h2>All files with their domain (${fileSortedByNamespace.length})</h2>
    <p>Look out for anomalies where the domain changes inside the same namespace.</p>
    
    <table>
        <thead>
            <tr>
                <th>Domain</th>
                <th>Namespace / Path</th>
                <th>Classname</th>
                <th>Internal / Private / Final</th>
            </tr>
        </thead>
        <tbody>
            ${fileSortedByNamespace.map(([classname, classInfo]) => `
                <tr>
                    <td class="domain-${(classInfo.domain || 'unknown').replace('@', '--')}">${classInfo.domain || 'unknown'}</td>
                    <td>${classInfo.namespace || classInfo.fileName}</td>
                    <td>${classInfo.className || 'N/A'}</td>
                    <td class="${(classInfo.isInternal || classInfo.isFinal) ? 'is-internal' : 'not-internal'}">${(classInfo.isInternal || classInfo.isFinal) ? 'Yes' : 'No'}</td>
                </tr>`).join('')}
        </tbody>
    </table>
</body>
</html>`;

try {
    const reportPath = './out/sw-domain-split-report.html';
    fs.writeFileSync(reportPath, htmlReport);
    console.log("html report written to", reportPath);
} catch (err) {
    console.error(err);
}
