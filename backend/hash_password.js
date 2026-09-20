const bcrypt = require('bcrypt');

const password = process.argv[2];

if (!password) {
  console.log('Usage: node hash_password.js <password>');
  process.exit(1);
}

bcrypt.hash(password, 10)
  .then(hash => {
    console.log('Hashed Password:', hash);
  })
  .catch(error => {
    console.error('Error hashing password:', error);
  });