import mysql from 'mysql2';

const connection = mysql.createConnection({
  host: 'localhost',         // your MySQL host
  user: 'your_mysql_user',   // your MySQL username
  password: 'your_password', // your MySQL password
  database: 'your_database'  // your MySQL database name
});

connection.connect((err) => {
  if (err) {
    console.error('MySQL connection error:', err);
    return;
  }
  console.log('Connected to MySQL database!');
});

export default connection;
