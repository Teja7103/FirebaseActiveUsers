const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { log } = require('../utils/logger');

const DEFAULT_BACKUP_DIR = './session-backups';

function getBackupDir() {
  return config.browser ? path.resolve(process.cwd(), config.browser.profileDir + '/../session-backups') : path.resolve(process.cwd(), DEFAULT_BACKUP_DIR);
}

function deriveKey(passphrase, salt) {
  return crypto.pbkdf2Sync(String(passphrase), salt, 100000, 32, 'sha256');
}

function encrypt(plainText, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = { v: 1, alg: 'AES-256-GCM', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: tag.toString('base64'), data: enc.toString('base64') };
  const json = JSON.stringify(payload);
  const keyFingerprint = crypto.createHash('sha256').update(passphrase).digest('hex');
  return { json, keyFingerprint };
}

function decrypt(payloadJson, passphrase) {
  const payload = JSON.parse(payloadJson);
  if (payload.v !== 1 || payload.alg !== 'AES-256-GCM') throw new Error('Unsupported backup payload');
  const key = deriveKey(passphrase, Buffer.from(payload.salt, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]);
  return dec.toString('utf8');
}

/**
 * Writes an AES-256-GCM encrypted backup of the browser storage state.
 */
function backupAuthState(storageStateJson, passphrase) {
  const dir = getBackupDir();
  fs.mkdirSync(dir, { recursive: true });
  const { json } = encrypt(storageStateJson, passphrase);
  const file = path.join(dir, 'google-session.json.enc');
  fs.writeFileSync(file, json, 'utf8');
  log('info', 'Encrypted session backup written', { file });
  return file;
}

/**
 * Restores an encrypted session backup. Returns true when a valid backup existed.
 */
function restoreAuthState(passphrase, targetFile) {
  const dir = getBackupDir();
  const file = path.join(dir, 'google-session.json.enc');
  if (!fs.existsSync(file)) return false;
  try {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    const plain = decrypt(JSON.stringify(payload), passphrase);
    const targetPath = targetFile ? path.resolve(process.cwd(), targetFile) : require('path').resolve(process.cwd(), './google-auth-state.json');
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, plain, 'utf8');
    log('info', 'Encrypted session backup restored');
    return true;
  } catch (err) {
    log('warn', 'Session backup restore failed', { error: err.message });
    return false;
  }
}

module.exports = { backupAuthState, restoreAuthState };
