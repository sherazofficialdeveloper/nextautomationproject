require('dotenv').config();
const {Pool}=require('pg');
const p=new Pool({connectionString:process.env.DATABASE_URL});
p.query("SELECT rolname FROM pg_roles WHERE rolname='Sheraz Developer'").then(r=>console.log('OK', r.rows)).catch(e=>console.log('ERR', e.message));
