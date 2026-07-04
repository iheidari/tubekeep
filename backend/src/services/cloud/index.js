// Cloud-provider registry. v1 ships Dropbox only; OneDrive/Google Drive slot in
// here behind the same shape (isEnabled/getPublicConfig/exchangeCode/refresh/
// upload). Routes and the job manager never import a provider directly — they
// resolve one through getProvider(name).

const dropbox = require('./dropbox');

const PROVIDERS = {
  dropbox,
};

function getProvider(name) {
  const provider = PROVIDERS[name];
  if (!provider?.isEnabled()) return null;
  return provider;
}

// The enabled providers plus their public (non-secret) config, for the
// frontend to decide whether to show a "Move to cloud" affordance.
function listEnabledProviders() {
  return Object.values(PROVIDERS)
    .filter((p) => p.isEnabled())
    .map((p) => ({ name: p.name, ...p.getPublicConfig() }));
}

module.exports = { getProvider, listEnabledProviders };
