// -----------------------------------------------------------------------------
// User-facing strings of the integration.
//
// Two distinct situations, because Gladys does NOT translate them the same way:
//
//   1. Where Gladys natively supports multi-language (the manifest config
//      schema, the action results, the connection-status message, and every
//      text of a dashboard widget), the code carries `{ en, fr }` objects and
//      Gladys picks the user's language. Nothing to configure.
//
//   2. The DEVICE name, the FEATURE names and the status option labels are
//      stored ONCE by Gladys as plain strings: there is no per-language
//      mechanism for them (the device exists once, with one name). Those come
//      from this module, in the language of LOCALE below.
//
// The default is English (the common denominator of a public integration).
// Switch LOCALE to 'fr' to store French names instead — relevant only when a
// device is (re)created: renaming an existing device requires deleting it and
// letting the integration rediscover it.
// -----------------------------------------------------------------------------

export const LOCALE = 'en';

const TEXTS = {
  device_name: { en: 'Huawei SUN2000 inverter', fr: 'Onduleur Huawei SUN2000' },

  // Feature names (30 features of the inverter device).
  power_ac: { en: 'AC power', fr: 'Puissance produite (AC)' },
  dc_power: { en: 'DC input power', fr: 'Puissance d\u2019entrée DC' },
  peak_power: { en: 'Daily peak power', fr: 'Puissance crête du jour' },
  daily_yield: { en: 'Daily yield', fr: 'Production du jour' },
  total_yield: { en: 'Total yield', fr: 'Production totale' },
  pv1_voltage: { en: 'String 1 voltage', fr: 'Tension string 1' },
  pv1_current: { en: 'String 1 current', fr: 'Courant string 1' },
  pv2_voltage: { en: 'String 2 voltage', fr: 'Tension string 2' },
  pv2_current: { en: 'String 2 current', fr: 'Courant string 2' },
  pv3_voltage: { en: 'String 3 voltage', fr: 'Tension string 3' },
  pv3_current: { en: 'String 3 current', fr: 'Courant string 3' },
  pv4_voltage: { en: 'String 4 voltage', fr: 'Tension string 4' },
  pv4_current: { en: 'String 4 current', fr: 'Courant string 4' },
  grid_volt_ab: { en: 'Grid voltage (A-B)', fr: 'Tension réseau (A-B)' },
  grid_volt_bc: { en: 'Grid voltage (B-C)', fr: 'Tension réseau (B-C)' },
  grid_volt_ca: { en: 'Grid voltage (C-A)', fr: 'Tension réseau (C-A)' },
  current_a: { en: 'Phase A current', fr: 'Courant phase A' },
  current_b: { en: 'Phase B current', fr: 'Courant phase B' },
  current_c: { en: 'Phase C current', fr: 'Courant phase C' },
  reactive_power: { en: 'Reactive power', fr: 'Puissance réactive' },
  power_factor: { en: 'Power factor', fr: 'Facteur de puissance' },
  frequency: { en: 'Grid frequency', fr: 'Fréquence réseau' },
  efficiency: { en: 'Efficiency', fr: 'Rendement' },
  temperature: { en: 'Internal temperature', fr: 'Température interne' },
  status: { en: 'Inverter state', fr: 'État de l\u2019onduleur' },
  fault: { en: 'Fault (error code)', fr: 'Anomalie (code défaut)' },
  running: { en: 'Inverter start / stop', fr: 'Marche / Arrêt de l\u2019onduleur' },
  meter_power: { en: 'Grid power (meter)', fr: 'Puissance réseau (compteur)' },
  meter_import_index: { en: 'Grid import index (meter)', fr: 'Énergie soutirée (compteur)' },
  meter_export_index: { en: 'Grid export index (meter)', fr: 'Énergie injectée (compteur)' },

  // Status option labels (register 32089).
  status_standby: { en: 'Standby', fr: 'Veille' },
  status_starting: { en: 'Starting', fr: 'Démarrage' },
  status_on_grid: { en: 'On grid', fr: 'Connecté au réseau' },
  status_on_grid_derating: { en: 'On grid (power limited)', fr: 'Connecté (puissance limitée)' },
  status_off_grid: { en: 'Off grid', fr: 'Hors réseau' },
  status_shutdown: { en: 'Shutdown', fr: 'Arrêté' },
  status_grid_scheduling: { en: 'Grid scheduling', fr: 'Planification réseau' },
  status_spot_check: { en: 'Spot check', fr: 'Diagnostic' },
  status_unknown: { en: 'Unknown', fr: 'Inconnu' },

  // Errors and user messages.
  no_command_handler: {
    en: 'No command handler for this feature',
    fr: 'Aucune commande disponible pour cette mesure',
  },
  invalid_running_value: {
    en: 'Invalid on/off value: use 1 to start, 0 to shut down',
    fr: 'Valeur marche/arrêt invalide : 1 pour démarrer, 0 pour arrêter',
  },
  command_refused: {
    en: 'The inverter refused the on/off command: it may require installer-level ' +
      'permissions or refuse remote commands in its current state.',
    fr: 'L\u2019onduleur a refusé la commande marche/arrêt : elle exige peut-être des ' +
      'droits installateur ou l\u2019onduleur refuse les commandes à distance dans son état actuel.',
  },
  unreachable: { en: 'Inverter unreachable: {reason}', fr: 'Onduleur injoignable : {reason}' },
  test_connection_en: {
    en: '{model} (serial {serial}, rated {rated} kW) - state: {status}, fault code: {fault}.',
    fr: '{model} (n° {serial}, {rated} kW nominal) - état : {status}, code défaut : {fault}.',
  },
  empty_serial: {
    en: 'The inverter returned an empty serial number',
    fr: 'L\u2019onduleur a renvoyé un numéro de série vide',
  },
  init_failed: {
    en: 'Initialization failed, check the integration logs.',
    fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  },
};

/**
 * The stored-once string of a key, in the LOCALE of the integration.
 * @param {string} key a key of TEXTS
 * @returns {string}
 */
export function t(key) {
  const entry = TEXTS[key];
  if (!entry) {
    throw new Error(`Unknown translation key: ${key}`);
  }
  return entry[effectiveLocale()] ?? entry.en;
}

/**
 * Fill the `{placeholder}`s of a message. Used for the few messages carrying
 * values; the result is a plain string in the LOCALE language (error messages
 * and logs are stored verbatim by Gladys, there is no re-translation).
 * @param {string} key a key of TEXTS
 * @param {Record<string, string | number>} values
 * @returns {string}
 */
export function tf(key, values = {}) {
  return messageIn(key, effectiveLocale(), values);
}

/**
 * Fill the `{placeholder}`s of a message in a GIVEN language. Used to build a
 * bilingual result `{ en, fr }` when the placeholders themselves are
 * per-language (a status label, for instance).
 * @param {string} key a key of TEXTS
 * @param {'en'|'fr'} locale
 * @param {Record<string, string | number>} values
 * @returns {string}
 */
export function messageIn(key, locale, values = {}) {
  const entry = TEXTS[key];
  if (!entry) {
    throw new Error(`Unknown translation key: ${key}`);
  }
  const template = entry[locale] ?? entry.en;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    values[name] === undefined ? match : String(values[name]),
  );
}

/**
 * The bilingual labels of a device status code (for the APIs Gladys
 * localizes itself).
 * @param {string} statusValue a status value of the inverter (e.g. 'on_grid')
 * @returns {{ en: string, fr: string }}
 */
export function bilingualStatus(statusValue) {
  const entry = TEXTS[`status_${statusValue}`] ?? TEXTS.status_unknown;
  return { en: entry.en, fr: entry.fr };
}

/**
 * The two-language message of a key (for the APIs Gladys localizes itself).
 * @param {string} key a key of TEXTS
 * @returns {{ en: string, fr: string }}
 */
export function bilingual(key) {
  const entry = TEXTS[key];
  if (!entry) {
    throw new Error(`Unknown translation key: ${key}`);
  }
  return { en: entry.en, fr: entry.fr };
}

// Test seam: override the locale (restored by passing null).
let localeOverride = null;

/**
 * @description Temporarily force the locale (tests only). Pass `null` to reset.
 * @param {'en'|'fr'|null} locale
 */
export function setLocaleForTests(locale) {
  localeOverride = locale;
}

// Internal: the effective locale, honoring the test override.
export function effectiveLocale() {
  return localeOverride ?? LOCALE;
}

export { TEXTS };
