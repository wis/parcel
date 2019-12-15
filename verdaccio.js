const {execSync, spawn} = require('child_process');
const fs = require('fs');
const path = require('path');

const run = cmd => execSync(cmd, {encoding: 'utf8', cwd: __dirname});
const bin = cmd => path.join(__dirname, 'node_modules/.bin', cmd);

const PORT = 4000;

const sha = run('git rev-parse --short HEAD').trim();
const version = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, 'packages/core/core/package.json'),
    'utf8',
  ),
).version;

const verdaccio = spawn(
  bin('verdaccio'),
  ['--listen', PORT, '--config', 'verdaccio.yml'],
  {cwd: __dirname},
);

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

verdaccio.kill('SIGINT');
