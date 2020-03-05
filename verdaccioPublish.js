const {execSync} = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2]);
if (!PORT) {
  console.error('You need to specify the port of Verdaccio:');
  console.error('  node verdaccioPublish.js 4000');
  process.exit(1);
}

const run = cmd => execSync(cmd, {encoding: 'utf8', cwd: __dirname});
const bin = cmd => path.join(__dirname, 'node_modules/.bin', cmd);

const sha = run('git rev-parse --short HEAD').trim();
const version = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'packages/core/core/package.json'),
    'utf8',
  ),
).version;

try {
  run(
    `${bin(
      'lerna',
    )} version -y --no-push --no-git-tag-version ${version}-${sha}`,
  );

  run(`git add .`);
  run(`git commit -m 'Temp' --no-verify`);

  run(
    `${bin(
      'lerna',
    )} publish -y --registry http://localhost:${PORT} from-package`,
  );
} finally {
  execSync(`git reset --hard ${sha}`);
}
