const { AbstractModule } = require('adapt-authoring-core');
/**
* Module which handles framework plugins
* @extends {AbstractModule}
*/
class ContentPluginModule extends AbstractModule {
  /** @override */
  constructor(...args) {
    super(...args);

    this.init();
  }

  async init() {
  	const server = await this.app.waitForModule('server');
    /**
    * Router instance used by the module
    * @type {Router}
    */
    this.router = server.api.createChildRouter('contentplugin');
    this.router.enableAPIMap();
    this.setReady();
  }
}

module.exports = ContentPluginModule;
