// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the Gladys server at install time, but nothing
// there can know which handlers the code registers: these tests keep both in
// sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEVICE_BLUEPRINTS } from '../src/devices/index.js';
import { DEFAULT_CONFIG } from '../src/config.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

const keysOf = (list) => (list ?? []).map((entry) => entry.key);

test('the manifest declares what the server requires', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  assert.ok(manifest.gladys_version, 'gladys_version is mandatory');
  assert.ok(
    manifest.transports.every((transport) => ['local', 'cloud'].includes(transport)),
    'transports are local or cloud',
  );
});

test('every manifest action has a registered handler', () => {
  const handled = new Set(DEVICE_BLUEPRINTS.flatMap((bp) => Object.keys(bp.actions ?? {})));
  for (const action of manifest.actions ?? []) {
    assert.ok(handled.has(action.key), `manifest action "${action.key}" has no handler`);
  }
});

test('config_schema keys are unique and never store a section', () => {
  const keys = manifest.config_schema.map((field) => field.key);
  assert.equal(new Set(keys).size, keys.length, 'duplicate config key');
  for (const section of manifest.config_schema.filter((field) => field.type === 'section')) {
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.equal(section.placeholder, undefined, `section "${section.key}" must not have a placeholder`);
    assert.ok(section.label?.en, `section "${section.key}" needs an English label`);
    assert.ok(
      !(section.key in DEFAULT_CONFIG),
      `section "${section.key}" stores no value and must not appear in DEFAULT_CONFIG`,
    );
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
    if (field.type === 'number') {
      assert.equal(field.min <= field.default, true, `${field.key}: min must not exceed the default`);
      assert.equal(field.max >= field.default, true, `${field.key}: max must not be below the default`);
    }
    if (field.type === 'select') {
      assert.ok(Array.isArray(field.options) && field.options.length > 1, `${field.key}: options`);
      assert.ok(
        field.options.some((option) => option.value === field.default),
        `${field.key}: the default must be one of the options`,
      );
    }
  }
});

test('every required field stores a value type', () => {
  const storable = ['string', 'number', 'boolean', 'select', 'multi_select', 'secret'];
  for (const field of manifest.config_schema.filter((entry) => entry.required)) {
    assert.ok(storable.includes(field.type), `${field.key}: required fields cannot be "${field.type}"`);
    assert.ok(field.label?.en, `${field.key}: English label`);
    assert.ok(field.label?.fr, `${field.key}: French label`);
  }
});

test('texts are multi-language objects, never plain strings', () => {
  const texts = [
    ...(manifest.config_schema ?? []),
    ...[...(manifest.actions ?? [])].flatMap((item) => item.fields ?? []),
  ].flatMap((field) => [
    ['label', field.label],
    ['description', field.description],
    ['placeholder', field.placeholder],
  ]);
  for (const [name, value] of texts) {
    if (value === undefined) continue;
    assert.equal(typeof value, 'object', `${name} must be a multi-language object`);
    assert.ok(value.en, `${name} needs an English text`);
  }
  for (const [language, text] of Object.entries(manifest.description)) {
    assert.ok(text.length >= 10 && text.length <= 100, `description.${language}: 10 to 100 characters`);
  }
});

test('the manifest version is the package version, and the image is tagged with it', () => {
  assert.equal(manifest.version, pkg.version, 'manifest version must match package.json');
  assert.ok(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    `docker_image must be tagged :${manifest.version}, got "${manifest.docker_image}"`,
  );
});

test('the catalog categories are part of the Gladys vocabulary and the version allows them', () => {
  // Unknown keys are dropped with a warning by the server, but an older core
  // rejects the whole manifest: `categories` needs Gladys >= 4.86.0.
  const vocabulary = [
    'climate',
    'lighting',
    'energy',
    'security',
    'multimedia',
    'appliances',
    'environment',
    'protocols',
    'network',
    'notifications',
    'assistants',
    'services',
    'transport',
    'vehicles',
    'servers',
    'leisure',
  ];
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  for (const category of manifest.categories) {
    assert.ok(vocabulary.includes(category), `unknown catalog category "${category}"`);
  }
  const match = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.(\d+)/);
  assert.ok(match, 'gladys_version must declare a minimum version');
  const [major, minor] = match.slice(1).map(Number);
  assert.ok(
    major > 4 || (major === 4 && minor >= 86),
    `categories requires gladys_version >= 4.86.0, got "${manifest.gladys_version}"`,
  );
});

test('keywords, when declared, hold their lengths', () => {
  // `keywords` is optional: when present it needs Gladys >= 5.3.0, which is
  // why this integration does not declare it (a store validator rule).
  const keywords = manifest.keywords ?? [];
  assert.ok(keywords.length <= 10);
  for (const keyword of keywords) {
    assert.ok(keyword.length >= 2 && keyword.length <= 30, `keyword "${keyword}"`);
  }
  if (keywords.length > 0) {
    const match = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.(\d+)/);
    assert.ok(match, 'gladys_version must declare a minimum version');
    const [major, minor, patch] = match.slice(1).map(Number);
    const atLeast530 = major > 5 || (major === 5 && (minor > 3 || (minor === 3 && patch >= 0)));
    assert.ok(atLeast530, `keywords requires gladys_version >= 5.3.0, got "${manifest.gladys_version}"`);
  }
});

test('unused manifest fields stay unused', () => {
  // The catalog rejects a config key the code never reads: every storable key
  // must exist in DEFAULT_CONFIG (sections were already excluded).
  for (const field of manifest.config_schema) {
    if (field.type === 'section') continue;
    assert.ok(
      field.key in DEFAULT_CONFIG || field.key === 'intro',
      `config key "${field.key}" is not read by the code`,
    );
  }
});
