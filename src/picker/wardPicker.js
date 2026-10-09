// Pure ward catalogue helpers: no DOM, no network. Every lookup walks the
// bundled per-installation config (config/constituency.json), so anything not
// listed there resolves to null and can never produce a fetch URL.

import { urlList } from '../roll/supplementTags.js';

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function findChild(list, id) {
  if (!Array.isArray(list) || typeof id !== 'string') return null;
  return list.find((item) => item && has(item, 'id') && item.id === id) || null;
}

function path(config, sel) {
  if (!config || typeof sel !== 'object' || sel === null) return null;
  const district = findChild(config.districts, sel.district);
  const samiti = district && findChild(district.samitis, sel.samiti);
  const panchayat = samiti && findChild(samiti.panchayats, sel.panchayat);
  const ward = panchayat && findChild(panchayat.wards, sel.ward);
  return ward ? { district, samiti, panchayat, ward } : null;
}

const options = (list) => (Array.isArray(list) ? list.map(({ id, label }) => ({ id, label })) : []);

export function districts(config) {
  return options(config && config.districts);
}

export function samitis(config, districtId) {
  const d = findChild(config && config.districts, districtId);
  return options(d && d.samitis);
}

export function panchayats(config, districtId, samitiId) {
  const d = findChild(config && config.districts, districtId);
  const s = d && findChild(d.samitis, samitiId);
  return options(s && s.panchayats);
}

export function wards(config, districtId, samitiId, panchayatId) {
  const d = findChild(config && config.districts, districtId);
  const s = d && findChild(d.samitis, samitiId);
  const p = s && findChild(s.panchayats, panchayatId);
  return options(p && p.wards);
}

/** PDF URL for a configured ward, or null for anything outside the config. */
export function resolveWard(config, sel) {
  const hit = path(config, sel);
  return hit && typeof hit.ward.pdfUrl === 'string' ? hit.ward.pdfUrl : null;
}

/**
 * { district, samiti, panchayat, ward, pdfUrl, supplementPdfUrls? } (ids) or
 * null; supplementPdfUrls, present when the ward's catalogue entry lists any,
 * are the ward's supplementary roll PDFs in publication order.
 */
export function selectionFor(config, sel) {
  const pdfUrl = resolveWard(config, sel);
  if (pdfUrl === null) return null;
  const selection = {
    district: sel.district,
    samiti: sel.samiti,
    panchayat: sel.panchayat,
    ward: sel.ward,
    pdfUrl,
  };
  const listed = path(config, sel).ward.supplementPdfUrls;
  if (Array.isArray(listed)) selection.supplementPdfUrls = urlList(listed);
  return selection;
}

/** The selection for a ward key ("district/samiti/panchayat/ward"), or null. */
export function selectionForWardKey(config, wardKey) {
  if (typeof wardKey !== 'string') return null;
  const parts = wardKey.split('/');
  if (parts.length !== 4) return null;
  const [district, samiti, panchayat, ward] = parts;
  return selectionFor(config, { district, samiti, panchayat, ward });
}
