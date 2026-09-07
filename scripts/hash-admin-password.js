const { randomBytes, scryptSync } = require('node:crypto');

async function readPassword() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return input.trim();
}

async function main() {
  const password = await readPassword();
  if (password.length < 12) {
    process.stderr.write('管理员密码至少需要 12 位\n');
    process.exit(1);
  }

  const salt = randomBytes(16);
  const passwordHash = scryptSync(password, salt, 64);
  process.stdout.write(`scrypt$${salt.toString('hex')}$${passwordHash.toString('hex')}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
