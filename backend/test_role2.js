const {Pool}=require('pg');
const p=new Pool({host:'localhost',port:5432,user:'postgres',password:'RAi@123',database:'next-railway_license_platform', ssl:false});
p.connect((err,client,done)=>{ if(err){console.log('err',err.message); return;}
client.query('SELECT u.id, u.username, u.role_id, pr.oid, pr.rolname FROM users u LEFT JOIN pg_roles pr ON pr.oid = u.role_id WHERE u.username=$1', ['Rai Sheraz'], (err,res)=>{ done(); if(err) console.log('query err:', err.message); else console.log('RESULT:', JSON.stringify(res.rows)); }) });
