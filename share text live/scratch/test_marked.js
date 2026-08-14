const marked = require('marked');

const input1 = `
Some text
<div>Test</div>
\`\`\`html
<html></html>
\`\`\`
`;

console.log("Normal:");
console.log(marked.parse(input1));

const escaped = input1.replace(/</g, '&lt;').replace(/>/g, '&gt;');
console.log("\nEscaped:");
console.log(marked.parse(escaped));
