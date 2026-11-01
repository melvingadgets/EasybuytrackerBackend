// Whether a MongoDB connection string points only at this machine. Migration scripts use it to refuse
// a shared database nobody deliberately asked for (AGENTS.md §7.4). Pure, and it imports no model, so
// a script can call it before connecting: a model compiled earlier would build its indexes on connect.

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export const isLocalDatabase = (uri: string): boolean => {
  // Only `mongodb://`: a `mongodb+srv://` address is a DNS name for a remote cluster by definition.
  const hosts = /^mongodb:\/\/(?:[^@/?]*@)?([^/?]+)/.exec(uri.trim())?.[1];
  return hosts !== undefined && hosts.split(",").every((host) => LOCAL_HOST.test(host));
};
