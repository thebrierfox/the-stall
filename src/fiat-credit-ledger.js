// Durable reservations for the existing single-process prepaid-credit ledger.
// Stripe purchases/refunds are not called here. Old entries remain compatible.
import { existsSync, readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
const PROCESS_INSTANCE = randomUUID();
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);

export function createFiatCreditLedger(path, { instance = PROCESS_INSTANCE } = {}) {
  function load() {
    const ledger = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
    if (!object(ledger)) throw new Error('invalid credit ledger');
    return ledger;
  }
  function save(ledger) {
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.reservation-${randomUUID()}`;
    let fd;
    try {
      fd = openSync(temp, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify(ledger)); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temp, path);
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
  function check(entry) {
    if (!object(entry) || !Number.isSafeInteger(entry.credits) || entry.credits < 0) throw new Error('invalid credit entry');
    if (entry.pending_credit_calls !== undefined && !object(entry.pending_credit_calls)) throw new Error('invalid reservations');
  }
  function recover() {
    const ledger = load(); let recovered = 0;
    for (const entry of Object.values(ledger)) {
      if (!object(entry) || !entry.pending_credit_calls) continue;
      check(entry);
      for (const [id, reservation] of Object.entries(entry.pending_credit_calls)) {
        if (!object(reservation) || reservation.units !== 1 || typeof reservation.instance !== 'string') throw new Error('invalid reservation');
        if (reservation.instance === instance) continue;
        // mountStripeRail is instantiated once by the verified single Node
        // service. A new instance is the restart boundary for pending calls.
        if (!Number.isSafeInteger(entry.credits + 1)) throw new Error('credit balance overflow');
        entry.credits += 1;
        delete entry.pending_credit_calls[id]; recovered += 1;
        entry.last_credit_outcome = { state: 'RECOVERED_AFTER_RESTART', at: new Date().toISOString() };
      }
    }
    if (recovered) save(ledger);
    return recovered;
  }
  function reserve(jti) {
    const ledger = load(); const entry = ledger[jti];
    if (!entry) return null;
    check(entry);
    if (entry.credits === 0) return null;
    const id = randomUUID();
    entry.credits -= 1;
    entry.pending_credit_calls ??= {};
    entry.pending_credit_calls[id] = { units: 1, instance, at: new Date().toISOString() };
    save(ledger);
    return { id, jti, remaining: entry.credits };
  }
  function finish(reservation, consumed) {
    const ledger = load(); const entry = ledger[reservation.jti];
    check(entry);
    const pending = entry.pending_credit_calls?.[reservation.id];
    if (!pending) return entry.credits; // replay cannot release a second credit
    if (pending.instance !== instance || pending.units !== 1) throw new Error('reservation owner mismatch');
    if (!consumed) {
      if (!Number.isSafeInteger(entry.credits + 1)) throw new Error('credit balance overflow');
      entry.credits += 1;
    }
    delete entry.pending_credit_calls[reservation.id];
    entry.last_credit_outcome = { state: consumed ? 'CONSUMED_SUCCESS' : 'RELEASED_UNSUCCESSFUL', at: new Date().toISOString() };
    save(ledger); return entry.credits;
  }
  return { recover, reserve, finish };
}

export function attachCreditOutcome(res, ledger, reservation, log = console) {
  let resolved = false, semanticFailure = false;
  const originalEnd = res.end;
  const originalJson = res.json;
  if (typeof originalJson === 'function') res.json = function (body) {
    semanticFailure = Boolean(body && typeof body === 'object' && !Array.isArray(body) && typeof body.error === 'string');
    return originalJson.call(this, body);
  };
  function settle(consumed) {
    if (resolved) return;
    const remaining = ledger.finish(reservation, consumed);
    resolved = true;
    if (!res.headersSent) res.setHeader('X-Fiat-Credits-Remaining', String(remaining));
  }
  function failedWrite() {
    log.error?.('[stripe-rail] credit reservation outcome persistence failed; reservation retained');
  }
  res.end = function (...args) {
    if (semanticFailure || res.statusCode < 200 || res.statusCode >= 300) {
      try { settle(false); }
      catch {
        failedWrite();
        if (res.headersSent) { res.destroy(); return res; }
        res.statusCode = 503;
        res.removeHeader('Content-Length');
        res.setHeader('Content-Type', 'application/json');
        args = [JSON.stringify({ error: 'fiat_credit_ledger_unavailable' })];
      }
    }
    return originalEnd.apply(this, args);
  };
  res.once('finish', () => {
    try { settle(!semanticFailure && res.statusCode >= 200 && res.statusCode < 300); }
    catch { failedWrite(); }
  });
  res.once('close', () => {
    if (!resolved) {
      try { settle(false); } catch { failedWrite(); }
    }
  });
}
