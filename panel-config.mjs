const anyHost = new Set(["0.0.0.0", "::"]);

export const panelHost = process.env.AC_PANEL_HOST || "127.0.0.1";
export const panelPort = Number(process.env.AC_PANEL_PORT || 3033);
export const panelHealthHost = anyHost.has(panelHost) ? "127.0.0.1" : panelHost;
export const panelListenUrl = `http://${panelHost}:${panelPort}/`;
export const panelLocalUrl = `http://${panelHealthHost}:${panelPort}/`;
