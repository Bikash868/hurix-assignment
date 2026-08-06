import { fileURLToPath } from 'node:url';
import path from 'node:path';
import duckdb from 'duckdb';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');

const MANIFEST_FILE = path.join(APP_ROOT, 'fixtures', 'build_manifest.csv');
const DB_PATH = path.join(APP_ROOT, 'releases.duckdb');
const CURRENT_KEY_PATH = path.join(APP_ROOT, 'keys', 'current', 'current.key.pem');
const CURRENT_CERT_PATH = path.join(APP_ROOT, 'keys', 'current', 'current.cert.pem');
const GATEWAY_BASE_URL = process.env.GATEWAY_BASE_URL || 'http://127.0.0.1:7070';

function openDb(path) {
	return new Promise((resolve, reject) => {
		const db = new duckdb.Database(path, (err) => (err ? reject(err) : resolve(db)));
	});
}

function execute(conn, sql, ...params) {
	return new Promise((resolve, reject) => {
		conn.run(sql, params, (err, result) => (err ? reject(err) : resolve(result)));
	});
}


function queryAll(conn, sql, ...params) {
	return new Promise((resolve, reject) => {
		conn.all(sql, params, (err, result) => (err ? reject(err) : resolve(result)));
	});
}

async function main() {
	const db = await openDb(DB_PATH);
	const conn = db.connect();

	try {
		console.error('db opened at:', DB_PATH);
	} finally {
		try {
			conn.close();
		} catch (error) {
			console.error('Error closing connection', error);
		}

		await new Promise((resolve) => db.close(() => resolve()))
	}

}

if(process.argv.includes('--report')) {
	main().catch((err) => {
		console.error('Error:', err);
		process.exit(1);
	})
}