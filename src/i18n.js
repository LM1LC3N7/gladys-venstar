// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature and option names, the status of
// the integration, the answers of the buttons and the command errors. None of
// them ever carries the user name, the password or the PIN.
// -----------------------------------------------------------------------------

import { FEATURES } from './constants.js';
import { ERROR_KINDS } from './venstar/http.js';

export const both = (en, fr) => ({ en, fr });
export const join = (...texts) =>
  both(texts.map((t) => t.en).join(' '), texts.map((t) => t.fr).join(' '));

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const DEVICE_NAME = (name) =>
  name
    ? both(`Venstar ${name}`, `Venstar ${name}`)
    : both('Venstar thermostat', 'Thermostat Venstar');

export const FEATURE_NAMES = {
  [FEATURES.TEMPERATURE]: both('Temperature', 'Température'),
  [FEATURES.HUMIDITY]: both('Humidity', 'Humidité'),
  [FEATURES.OUTDOOR]: both('Outdoor temperature', 'Température extérieure'),
  [FEATURES.HEAT_SETPOINT]: both('Heating setpoint', 'Consigne de chauffage'),
  [FEATURES.COOL_SETPOINT]: both('Cooling setpoint', 'Consigne de climatisation'),
  [FEATURES.MODE]: both('Mode', 'Mode'),
  [FEATURES.FAN]: both('Fan', 'Ventilation'),
  [FEATURES.FAN_RUNNING]: both('Fan running', 'Ventilation en marche'),
  [FEATURES.OPERATING_STATE]: both('Operating state', 'Fonctionnement'),
  [FEATURES.STATUS]: both('Status', 'État'),
  [FEATURES.FILTER]: both('Filter alert', 'Alerte filtre'),
  [FEATURES.ALERTS]: both('Alerts', 'Alertes'),
};

export const MODE_NAMES = {
  off: both('Off', 'Arrêt'),
  heat: both('Heating', 'Chauffage'),
  cool: both('Cooling', 'Climatisation'),
  auto: both('Auto', 'Auto'),
};

export const FAN_NAMES = {
  auto: both('Auto', 'Auto'),
  on: both('Always on', 'Toujours en marche'),
};

export const STATE_NAMES = {
  0: both('Idle', 'En attente'),
  1: both('Heating', 'Chauffe'),
  2: both('Cooling', 'Refroidit'),
  3: both('Lockout', 'Verrouillé'),
  4: both('Error', 'Erreur'),
};

export const NO_ALERT = both('None', 'Aucune');

/** Our own short reason of a failure (never a byte of an answer). */
export function errorReason(err) {
  switch (err?.kind) {
    case ERROR_KINDS.UNREACHABLE:
      return 'unreachable';
    case ERROR_KINDS.TIMEOUT:
      return 'no answer in time';
    case ERROR_KINDS.HTTP:
      return `HTTP ${Number.isInteger(err.status) ? err.status : '?'}`;
    case ERROR_KINDS.BUSY:
      return `busy (HTTP ${Number.isInteger(err.status) ? err.status : '?'})`;
    case ERROR_KINDS.PROTOCOL:
      return 'not a Venstar answer';
    case ERROR_KINDS.AUTH:
      return 'user name or password refused';
    case ERROR_KINDS.AUTH_NEEDED:
      return 'a password is asked';
    case ERROR_KINDS.CERTIFICATE:
      return 'certificate changed';
    case ERROR_KINDS.LATE:
      return 'too late';
    case ERROR_KINDS.CLOSED:
    case ERROR_KINDS.ABORTED:
      return 'connection closed';
    case ERROR_KINDS.STORAGE:
      return '/data not writable';
    case ERROR_KINDS.STALE:
      return 'configuration changed';
    default:
      return err?.kind ? String(err.kind).slice(0, 40) : 'error';
  }
}

const unitSign = (unit) => (unit === 'fahrenheit' || unit === 'F' ? '°F' : '°C');

export const T = {
  noAddress: both(
    'Enter the IP address of the thermostat in the configuration.',
    "Saisissez l'adresse IP du thermostat dans la configuration.",
  ),
  invalidAddress: (text) =>
    both(`"${text}" is not a valid address.`, `« ${text} » n'est pas une adresse valide.`),
  pinInvalid: both(
    'The PIN must be 1 to 4 digits: it is not sent.',
    "Le code PIN doit faire 1 à 4 caractères numériques : il n'est pas envoyé.",
  ),
  pinRefused: both(
    'The PIN was refused by the thermostat: commands stay refused until you change it.',
    'Le code PIN a été refusé par le thermostat : les commandes restent refusées tant que vous ne le changez pas.',
  ),
  usernameInvalid: both(
    'The user name holds a quote, a backslash or a control character: it cannot be sent in the Digest header. Change it on the thermostat and in the configuration.',
    "Le nom d'utilisateur contient un guillemet, une barre oblique inverse ou un caractère de contrôle : il ne peut pas être envoyé dans l'en-tête Digest. Changez-le sur le thermostat et dans la configuration.",
  ),
  connecting: both('Connecting to the thermostat…', 'Connexion au thermostat…'),
  connected: (name, model) =>
    both(
      `Connected to ${name ? `"${name}"` : 'the thermostat'} (${model}).`,
      `Connecté à ${name ? `« ${name} »` : 'au thermostat'} (${model}).`,
    ),
  unreachable: (reason, wait) =>
    both(
      `The thermostat does not answer (${reason}); next try in ${wait.en}.`,
      `Le thermostat ne répond pas (${reason}) ; nouvel essai dans ${wait.fr}.`,
    ),
  busy: (wait) =>
    both(
      `The thermostat asks to wait: reads paused for ${wait.en}.`,
      `Le thermostat demande d'attendre : lectures en pause pendant ${wait.fr}.`,
    ),
  refused: both(
    'The thermostat refused the user name or the password: not tried again until you change them or click "Test the connection".',
    "Le thermostat a refusé le nom d'utilisateur ou le mot de passe : pas de nouvel essai tant que vous ne les changez pas ou ne cliquez pas sur « Tester la connexion ».",
  ),
  authNeeded: both(
    'The thermostat asks for a password: turn on HTTPS and enter the user name and password of its "Basic Auth" (never sent over plain HTTP).',
    "Le thermostat demande un mot de passe : activez HTTPS et saisissez le nom d'utilisateur et le mot de passe de son « Basic Auth » (jamais envoyés en HTTP simple).",
  ),
  unsupported: (version) =>
    both(
      `This thermostat offers API version ${version}: version 3 or later is needed.`,
      `Ce thermostat propose la version ${version} de l'API : la version 3 ou plus est nécessaire.`,
    ),
  unitUnknown: both(
    'The temperature unit of the thermostat cannot be told: nothing is shown.',
    "L'unité de température du thermostat est inconnue : rien n'est affiché.",
  ),
  certificateChanged: (fingerprint) =>
    both(
      `The certificate of the thermostat changed (now ${fingerprint}): nothing is sent to it, the password neither. If you replaced or reset the thermostat, click "Accept the change" twice.`,
      `Le certificat du thermostat a changé (maintenant ${fingerprint}) : rien ne lui est envoyé, le mot de passe non plus. Si vous avez remplacé ou réinitialisé le thermostat, cliquez deux fois sur « Accepter le changement ».`,
    ),
  otherThermostat: (identity) =>
    both(
      `Another thermostat answers at this address (${describe(identity)}): its values are not shown and commands are refused. If it is the same one (renamed, replaced), click "Accept the change" twice; else give your thermostat a fixed address in your router.`,
      `Un autre thermostat répond à cette adresse (${describe(identity)}) : ses valeurs ne sont pas affichées et les commandes sont refusées. Si c'est le même (renommé, remplacé), cliquez deux fois sur « Accepter le changement » ; sinon donnez à votre thermostat une adresse fixe dans votre routeur.`,
    ),
  identityUnknown: both(
    'The thermostat did not say its name and model this time: values not shown, commands refused until the next read.',
    "Le thermostat n'a pas donné son nom et son modèle cette fois : valeurs non affichées, commandes refusées jusqu'à la prochaine lecture.",
  ),
  storage: both(
    '/data is not writable: the certificate cannot be pinned, so the password is not sent.',
    "/data n'est pas accessible en écriture : le certificat ne peut pas être épinglé, le mot de passe n'est donc pas envoyé.",
  ),
  test: {
    cooldown: both('Tested moments ago.', 'Testé il y a un instant.'),
    waiting: (wait) =>
      both(
        `Not read again before the interval: next read in ${wait.en}.`,
        `Pas de nouvelle lecture avant l'intervalle : prochaine lecture dans ${wait.fr}.`,
      ),
  },
  accept: {
    nothing: both(
      'No new certificate nor other thermostat was met: nothing to accept.',
      'Aucun nouveau certificat ni autre thermostat rencontré : rien à accepter.',
    ),
    confirm: (what) =>
      both(
        `To accept: ${what.en}. Compare it, then click again within 60 s to accept exactly this.`,
        `À accepter : ${what.fr}. Comparez, puis cliquez de nouveau dans les 60 s pour accepter exactement ceci.`,
      ),
    done: both(
      'Accepted: the next read shows the thermostat.',
      'Accepté : la prochaine lecture affiche le thermostat.',
    ),
  },
};

export function describe(identity) {
  if (!identity) {
    return '?';
  }
  return [identity.name ? `"${identity.name}"` : undefined, identity.model, identity.type]
    .filter(Boolean)
    .join(', ');
}

export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  badValue: both('Value not accepted by this feature.', 'Valeur refusée par cette fonctionnalité.'),
  disabled: both(
    'Commands are disabled ("Allow the commands" in the configuration).',
    'Les commandes sont désactivées (« Autoriser les commandes » dans la configuration).',
  ),
  outOfRange: (min, max, unit) =>
    both(
      `Setpoint refused: between ${min} and ${max} ${unitSign(unit)} only.`,
      `Consigne refusée : entre ${min} et ${max} ${unitSign(unit)} seulement.`,
    ),
  outOfLimits: (min, max, unit) =>
    both(
      `Setpoint refused: the thermostat accepts ${min} to ${max} ${unitSign(unit)}.`,
      `Consigne refusée : le thermostat accepte ${min} à ${max} ${unitSign(unit)}.`,
    ),
  deadband: (delta, unit) =>
    both(
      `Refused: in auto mode the cooling setpoint must stay ${delta} ${unitSign(unit)} above the heating one.`,
      `Refusé : en mode auto, la consigne de climatisation doit rester ${delta} ${unitSign(unit)} au-dessus de celle de chauffage.`,
    ),
  modeUnavailable: both(
    'This thermostat does not offer this mode.',
    'Ce thermostat ne propose pas ce mode.',
  ),
  unknownDevice: both(
    'This thermostat is not the one configured, or was not read yet.',
    "Ce thermostat n'est pas celui configuré, ou n'a pas encore été lu.",
  ),
  unknownUnit: both(
    'The unit of this feature is not known: command refused.',
    "L'unité de cette fonctionnalité est inconnue : commande refusée.",
  ),
  busy: both(
    'The thermostat asked to wait: command refused, nothing sent.',
    "Le thermostat a demandé d'attendre : commande refusée, rien n'a été envoyé.",
  ),
  credentialsRefused: both(
    'The user name or the password is refused: command not sent.',
    "Le nom d'utilisateur ou le mot de passe est refusé : commande non envoyée.",
  ),
  pinRefused: both(
    'The PIN was refused before: command not sent (change the PIN in the configuration).',
    'Le code PIN a déjà été refusé : commande non envoyée (changez le code PIN dans la configuration).',
  ),
  stillRunning: both(
    'A previous command is still running: try again in a moment.',
    'Une commande précédente est en cours : réessayez dans un instant.',
  ),
  cancelled: both(
    'Cancelled by a newer command (off), nothing sent.',
    "Annulée par une commande plus récente (arrêt), rien n'a été envoyé.",
  ),
  superseded: both(
    'Sent, but an off command followed it: the off command is written again.',
    "Envoyée, mais une commande d'arrêt l'a suivie : l'arrêt est réécrit.",
  ),
  previousPending: both(
    'A previous setpoint command is not confirmed yet: refused, so that it is not overwritten by the old value. Try again in a moment.',
    "Une commande de consigne précédente n'est pas encore confirmée : refusée, pour ne pas la remplacer par l'ancienne valeur. Réessayez dans un instant.",
  ),
  tooSlow: both(
    'The thermostat was too slow: command refused, nothing sent.',
    "Le thermostat a été trop lent : commande refusée, rien n'a été envoyé.",
  ),
  notSent: (reason) => both(`Command not sent (${reason}).`, `Commande non envoyée (${reason}).`),
  refused: both('The thermostat refused the command.', 'Le thermostat a refusé la commande.'),
  refusedPin: both(
    'The thermostat refused the PIN: command not applied, PIN kept refused.',
    'Le thermostat a refusé le code PIN : commande non appliquée, code PIN retenu comme refusé.',
  ),
  sentUnconfirmed: (reason) =>
    both(
      `Command sent, without confirmation (${reason}): the state is read again shortly.`,
      `Commande envoyée, sans confirmation (${reason}) : l'état est relu sous peu.`,
    ),
  unknownState: (reason) =>
    both(
      `The state of the thermostat could not be read (${reason}): command not sent.`,
      `L'état du thermostat n'a pas pu être lu (${reason}) : commande non envoyée.`,
    ),
  incompleteState: both(
    'The thermostat did not give a value this command needs: not sent.',
    "Le thermostat n'a pas donné une valeur dont cette commande a besoin : non envoyée.",
  ),
  otherThermostat: both(
    'Another thermostat answers at this address: command refused.',
    'Un autre thermostat répond à cette adresse : commande refusée.',
  ),
  identityUnknown: both(
    'The thermostat did not say its name and model: command refused.',
    "Le thermostat n'a pas donné son nom et son modèle : commande refusée.",
  ),
  certificate: both(
    'The certificate of the thermostat changed: nothing sent.',
    "Le certificat du thermostat a changé : rien n'a été envoyé.",
  ),
};
