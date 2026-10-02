import View from "./view";
import type { CoreContext } from "@taskasaur/platform/plugin-sdk";
export default {
  async activate(context: CoreContext) {
    const ui = context.services.require<any>("core.ui");
    const runtime = context.services.require("core.workspace");
    return ui.registerSurface({
      id: "email-client",
      label: "Mail",
      render: () => ui.React.createElement(View, { runtime }),
    });
  },
};
