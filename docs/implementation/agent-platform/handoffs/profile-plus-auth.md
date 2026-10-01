# Plus authentication truthfulness and cancellation

Root P03 prerequisite, following `50e3434`. Desktop token exchange and device enrollment now require valid server-issued account/access/device tokens. Credentials are committed only after both desktop steps succeed. CLI login requires a real transaction and valid enrollment exchange; failed/offline creation no longer invents verification codes. Self-hosted enrollment rejects missing device tokens. `enrolled` means a device enrollment token exists, not merely an access token.

Each desktop/CLI attempt owns cancellation. Logout, mode changes, replacement login and service stop cancel pending flows; generation checks prevent late successful responses from reconnecting after logout. Callback state is checked before provider errors, repeated callbacks cannot exchange twice, error HTML is escaped, and auth responses have request deadlines and bounded bodies. Tests inject explicit fixture transports; production never selects a mock/fallback transport.

Validation: typecheck passed. Four auth/storage/control test files passed, 28 tests total, including real loopback callbacks, failed/malformed token and enrollment responses, delayed response after cancel/logout, bounded body, HTML escaping, CLI cancellation/validation, and two ControlStore roots. No live Plus accounts were used. Actual hosted/self-hosted interoperability remains a release qualification task requiring the server contract and fixture service; these checks do not claim live-server compatibility.

Profile protocol/UI binding and migration activation are still pending. These changes preserve explicit ControlStore-root ownership and remove known false-success paths before profiles are enabled.
