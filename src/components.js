'use strict';
const { err } = require('./util');

const bad = (path, reason) => err('invalid_form_body', 400, { message: `Invalid Form Body: ${path}: ${reason}` });
const SELECTS = new Set([3, 5, 6, 7, 8]);
const str = (v, n) => (v == null || v === '' ? undefined : String(v).slice(0, n));

function emoji(e) {
  if (!e || typeof e !== 'object') return undefined;
  const name = str(e.name, 64), id = e.id != null ? String(e.id).slice(0, 32) : undefined;
  return name || id ? { ...(id ? { id } : {}), ...(name ? { name } : {}), ...(e.animated ? { animated: true } : {}) } : undefined;
}
function button(c, p) {
  const style = Number(c.style);
  if (!(style >= 1 && style <= 5)) throw bad(`${p}.style`, 'must be 1 to 5');
  const out = { type: 2, style, disabled: !!c.disabled };
  const label = str(c.label, 80), em = emoji(c.emoji);
  if (!label && !em) throw bad(p, 'a button needs a label or an emoji');
  if (label) out.label = label;
  if (em) out.emoji = em;
  if (style === 5) {
    if (!/^https?:\/\/\S+$/i.test(String(c.url || ''))) throw bad(`${p}.url`, 'a link button needs a http(s) url');
    out.url = String(c.url).slice(0, 512);
  } else {
    const id = str(c.custom_id, 100);
    if (!id) throw bad(`${p}.custom_id`, 'is required');
    out.custom_id = id;
  }
  return out;
}
function select(c, p) {
  const type = Number(c.type);
  const id = str(c.custom_id, 100);
  if (!id) throw bad(`${p}.custom_id`, 'is required');
  const out = { type, custom_id: id, disabled: !!c.disabled };
  const ph = str(c.placeholder, 150);
  if (ph) out.placeholder = ph;
  const max = c.max_values == null ? 1 : Number(c.max_values), min = c.min_values == null ? 1 : Number(c.min_values);
  if (!Number.isInteger(max) || max < 1 || max > 25) throw bad(`${p}.max_values`, 'must be 1 to 25');
  if (!Number.isInteger(min) || min < 0 || min > 25 || min > max) throw bad(`${p}.min_values`, 'must be 0 to max_values');
  out.min_values = min; out.max_values = max;
  if (type === 3) {
    if (!Array.isArray(c.options) || !c.options.length || c.options.length > 25) throw bad(`${p}.options`, 'a select menu needs 1 to 25 options');
    out.options = c.options.map((o, i) => {
      const label = str(o?.label, 100), value = str(o?.value, 100);
      if (!label || !value) throw bad(`${p}.options[${i}]`, 'needs a label and a value');
      return { label, value, ...(str(o.description, 100) ? { description: str(o.description, 100) } : {}), ...(emoji(o.emoji) ? { emoji: emoji(o.emoji) } : {}), ...(o.default ? { default: true } : {}) };
    });
  }
  return out;
}
function clean(list) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > 5) throw bad('components', 'must be a list of up to 5 action rows');
  return list.map((row, i) => {
    const p = `components[${i}]`;
    if (!row || Number(row.type) !== 1 || !Array.isArray(row.components)) throw bad(p, 'must be an action row');
    const items = row.components;
    if (!items.length || items.length > 5) throw bad(`${p}.components`, 'a row holds 1 to 5 components');
    const selectRow = items.some(x => SELECTS.has(Number(x?.type)));
    if (selectRow && items.length !== 1) throw bad(`${p}.components`, 'a select menu fills a whole row');
    return { type: 1, components: items.map((c, j) => {
      const q = `${p}.components[${j}]`;
      if (Number(c?.type) === 2) return button(c, q);
      if (SELECTS.has(Number(c?.type))) return select(c, q);
      throw bad(`${q}.type`, 'unsupported component');
    }) };
  });
}

function textInput(c, p) {
  const id = str(c.custom_id, 100);
  if (!id) throw bad(`${p}.custom_id`, 'is required');
  const out = { type: 4, custom_id: id, style: Number(c.style) === 2 ? 2 : 1, required: c.required !== false };
  for (const [k, n] of [['label', 45], ['placeholder', 100], ['value', 4000]]) if (str(c[k], n) !== undefined) out[k] = str(c[k], n);
  if (c.min_length != null) { if (!Number.isInteger(c.min_length) || c.min_length < 0 || c.min_length > 4000) throw bad(`${p}.min_length`, 'must be 0 to 4000'); out.min_length = c.min_length; }
  if (c.max_length != null) { if (!Number.isInteger(c.max_length) || c.max_length < 1 || c.max_length > 4000) throw bad(`${p}.max_length`, 'must be 1 to 4000'); out.max_length = c.max_length; }
  return out;
}
function modal(data) {
  const id = str(data?.custom_id, 100), title = str(data?.title, 45);
  if (!id || !title) throw bad('data', 'a modal needs a custom_id and a title');
  const list = data.components;
  if (!Array.isArray(list) || !list.length || list.length > 5) throw bad('data.components', 'a modal holds 1 to 5 rows');
  const components = list.map((row, i) => {
    const p = `data.components[${i}]`;
    if (Number(row?.type) === 18) {
      const inner = row.component;
      if (Number(inner?.type) !== 4) throw bad(`${p}.component`, 'only text inputs are supported');
      return { type: 18, label: str(row.label, 45) || '', ...(str(row.description, 100) ? { description: str(row.description, 100) } : {}), component: textInput(inner, `${p}.component`) };
    }
    if (Number(row?.type) !== 1 || !Array.isArray(row.components) || row.components.length !== 1 || Number(row.components[0]?.type) !== 4) throw bad(p, 'must be an action row with one text input');
    return { type: 1, components: [textInput(row.components[0], `${p}.components[0]`)] };
  });
  return { custom_id: id, title, components };
}
const inputsOf = m => m.components.map(r => (r.type === 18 ? r.component : r.components[0]));

function find(components, customId) {
  for (const row of components || []) for (const c of row.components || []) if (c.custom_id === customId) return c;
  return null;
}

module.exports = { clean, modal, inputsOf, find };
