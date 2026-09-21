const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const { VitePlugin } = require("@electron-forge/plugin-vite");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");
const electronAutomation = process.env.TASK_SYNC_E2E_PACKAGE === "1";

module.exports = {
  outDir: "desktop-out",
  packagerConfig: {
    asar: true,
    executableName: "task-sync",
    name: "Task Sync",
  },
  rebuildConfig: {},
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: {
        name: "task_sync",
        authors: "Gabriel Cintron",
        description: "Safely sync school obligations to Todoist",
      },
    },
    {
      name: "@electron-forge/maker-deb",
      platforms: ["linux"],
      config: {
        options: {
          maintainer: "Gabriel Cintron",
          homepage: "https://github.com/Gabriel-Cintron/task-sync",
        },
      },
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin", "linux"],
    },
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: "src/desktop/main.ts", config: "vite.main.config.mjs", target: "main" },
        { entry: "src/desktop/preload.ts", config: "vite.preload.config.mjs", target: "preload" },
      ],
      renderer: [
        { name: "main_window", config: "vite.renderer.config.mjs" },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      // Playwright's Electron driver needs these three development entry points.
      // Release packages keep all of them disabled.
      [FuseV1Options.RunAsNode]: electronAutomation,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: electronAutomation,
      [FuseV1Options.EnableNodeCliInspectArguments]: electronAutomation,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    }),
  ],
};
