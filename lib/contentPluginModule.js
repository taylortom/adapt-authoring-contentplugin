const { AbstractModule, Responder, Utils } = require('adapt-authoring-core');
/**
* Module which handles framework plugins
* @extends {AbstractModule}
*/
class ContentPluginModule extends AbstractModule {
  /** @override */
  preload(app, resolve, reject) {
    Utils.defineGetter(this, 'router', app.getModule('server').api.createChildRouter('contentplugin'));
    app.auth.secureRoute(`${this.router.path}/`, 'GET', [ 'read:content' ]);
    resolve();
  }
  /** @override */
  boot(app, resolve, reject) {
    this.router._router.get('/', this.sendRouterMap.bind(this));
    resolve();
  }
  /**
  *
  */
  sendRouterMap(req, res) {
    return new Responder(res).success(this.router.map);
  }
}

module.exports = ContentPluginModule;
