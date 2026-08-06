import { fileURLToPath } from 'node:url';
import path from 'node:path';
import duckdb from 'duckdb';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

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
		conn.run(sql, ...params, (err, result) => (err ? reject(err) : resolve(result)));
	});
}


function queryAll(conn, sql, ...params) {
	return new Promise((resolve, reject) => {
		conn.all(sql, ...params, (err, result) => (err ? reject(err) : resolve(result)));
	});
}

const RECONCILE_SQL = `
  WITH cte AS (
    SELECT DISTINCT * FROM manifest
  ),
  withdrawn_ids AS (
    SELECT DISTINCT supersedes_id AS entry_id
    FROM cte
    WHERE record_type = 'WITHDRAWAL'
  ),
  surviving_builds AS (
    SELECT d.*
    FROM cte d
    WHERE d.record_type = 'BUILD'
      AND NOT EXISTS (
        SELECT 1 FROM withdrawn_ids w WHERE w.entry_id = d.entry_id
      )
  )
  SELECT bundle_id,
         COUNT(*) AS artifact_count,
         SUM(size_bytes) AS total_bytes
  FROM surviving_builds
  GROUP BY bundle_id
  ORDER BY bundle_id;
`


function canonicaljson(value) {
	if(Array.isArray(value)) {
		return '['+ value.map(canonicaljson).join(',') + ']';
	} else if(typeof value === 'object' && value !== null) {
		const values = Object.keys(value)
			.sort()
			.map(k => JSON.stringify(k) + ':' + canonicaljson(value[k]));

		return '{'+ values.join(',') + '}';
	}

	return JSON.stringify(value);
}


function signDescriptor(descriptor) {
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-'));
	const descriptorFile = path.join(scratch, 'descriptor.bin');
	const sigFile = path.join(scratch, 'sig.pem');
	try {
		fs.writeFileSync(descriptorFile, descriptor);
		execFileSync(
		  'openssl',
		  [
			'cms', '-sign',
			'-in', descriptorFile,
			'-signer', CURRENT_CERT_PATH,
			'-inkey', CURRENT_KEY_PATH,
			'-outform', 'PEM',
			'-binary',
			'-out', sigFile,
		  ],
		  { stdio: ['ignore', 'ignore', 'pipe'] }
		);
		return fs.readFileSync(sigFile, 'utf8');
	  } finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	  }
}

async function getCurrentSigningKey() {

	const res = await fetch(`${GATEWAY_BASE_URL}/v1/signing-key/current`);

	if(!res.ok) {
		throw new Error(`Failed to get current signing key: ${res.status} ${res.statusText}`);
	}

	const key = res.json();
	console.error("in getCurrentSigningKeycurrnet key:", key);
	return key;
}


async function submitPublication(descriptor, signature, requestToken) {
	const res = await fetch(`${GATEWAY_BASE_URL}/v1/publications`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ descriptor, signature, request_token: requestToken }),
	  });
	  const response = await res.json();
	  if (!res.ok || response.error) {
		throw new Error(
		  `error submitting publication for ${requestToken}: ${response.error || res.status}`
		);
	  }

	  console.error("submit success:", response); // { publication_id, request_token, status }
	  return response; 
}

async function main() {
	const db = await openDb(DB_PATH);
	const conn = db.connect();

	try {
		const escapedPath = MANIFEST_FILE.replace(/'/g, "''");
		await execute(
			conn,
			`CREATE OR REPLACE TABLE manifest AS SELECT * FROM read_csv_auto('${escapedPath}')`
		)

		const bundles = await queryAll(
			conn,
			RECONCILE_SQL
		)

		await execute(
			conn,
			`CREATE TABLE IF NOT EXISTS publications (
			   bundle_id       VARCHAR PRIMARY KEY,
			   artifact_count  BIGINT,
			   total_bytes     BIGINT,
			   descriptor      VARCHAR,
			   request_token   VARCHAR,
			   publication_id  VARCHAR,
			   key_id          VARCHAR,
			   status          VARCHAR
			 )`
		  );

		// console.log(bundles);

		let keyInfoPromise = null;
		const getKeyInfo = () => (keyInfoPromise ??= getCurrentSigningKey());

		const rows = []
		for(const bundle of bundles) {
			const bundleId = bundle.bundle_id

			const existingRows = await queryAll(
				conn,
				`SELECT * FROM publications WHERE bundle_id = ?`,
				bundleId
			  );

			let record;
			if (existingRows.length > 0) {
				record = existingRows[0];
			} else {
				const descriptorObj = {
					artifact_count: Number(bundle.artifact_count),
					bundle_id: bundleId,
					total_bytes: Number(bundle.total_bytes),
				}
	
				const descriptor = canonicaljson(descriptorObj);
	
				const requestToken = `token-${bundleId}`
				
				const signature = signDescriptor(Buffer.from(descriptor, 'utf8'));
				const response = await submitPublication(descriptor, signature, requestToken);

				const keyInfo = await getKeyInfo();

				await execute(
					conn,
					`INSERT INTO publications VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					bundleId,
					descriptorObj.artifact_count,
					descriptorObj.total_bytes,
					descriptor,
					requestToken,
					response.publication_id,
					keyInfo.key_id,
					response.status
				  );

				record = {
					bundle_id: bundleId,
					request_token: requestToken,
					publication_id: response.publication_id,
					key_id: keyInfo.key_id,
					status: response.status,
				};
	
				}
				rows.push(`BUNDLE ${record.bundle_id} SIGNED KEY=${record.key_id}`)
	
				rows.push(
					`BUNDLE ${record.bundle_id} PUBLISHED RECEIPT=${record.publication_id} ` +
					  `TOKEN=${record.request_token} STATUS=${record.status}`
				  );
		}
		process.stdout.write(rows.join('\n') + '\n');

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