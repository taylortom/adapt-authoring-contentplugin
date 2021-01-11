const AbstractApiModule = require('adapt-authoring-api');
const cli = require('adapt-cli').api.commands;
const fs = require('fs-extra');
const path = require('path');
const semver = require('semver');
const zipper = require('zipper');
const util = require('util');

const globPromise = util.promisify(require('glob'));
/**
 * Abstract module which handles framework plugins
 * @extends {AbstractApiModule}
 */
class ContentPluginModule extends AbstractApiModule {
  /** @override */
  async setValues() {
    this.collectionName = 'contentplugins';
    this.root = 'contentplugins';
    this.schemaName = 'contentplugin';
    this.pluginSchemas = [];

    const middleware = await this.app.waitForModule('middleware');

    this.routes = [
      {
        route: '/install',
        handlers: { post: [
          middleware.fileUploadParser('application/zip', { unzip: true }),
          this.installHandler.bind(this)
        ] },
        permissions: { post: ['install:contentplugin'] },
        validate: false
      },
      {
        route: '/query',
        handlers: { post: this.queryHandler() },
        permissions: { post: ['read:contentplugin'] },
        validate: false
      },
      {
        route: '/schema',
        handlers: { post: this.serveSchema() },
        permissions: { post: ['read:schema'] }
      },
      {
        route: '/:_id/update',
        handlers: { post: this.updateHandler.bind(this) },
        permissions: { post: ['update:contentplugin'] }
      },
      {
        route: '/:_id/uninstall',
        handlers: { post: this.uninstallHandler.bind(this) },
        permissions: { post: ['install:contentplugin'] }
      },
      {
        route: '/:_id?',
        handlers: { get: this.requestHandler() },
        permissions: { get: ['read:contentplugin'] }
      },
      {
        route: '/:_id',
        handlers: { patch: this.requestHandler() },
        permissions: { patch: ['write:contentplugin'] }
      }
    ];
  }
  /** @override */
  async init() {
    await super.init();

    const [framework, mongodb] = await this.app.waitForModule('adaptFramework', 'mongodb');

    mongodb.setIndex(this.collectionName, 'name', { unique: true });

    this.framework = framework;
    try {
      await this.installPlugins();
      await this.processPluginSchemas();
    } catch(e) {
      this.log('error', e);
    }
  }
  /**
   * Installs all framework plugins specified in adapt.json
   * @return {Promise}
   */
  async installPlugins() {
    const existingPlugins = (await this.find({})).map(p => p.name);
    const deps = Object.entries((await fs.readJSON(`${this.framework.path}/adapt.json`)).dependencies);
    for(const [name, version] of deps) {
      if(existingPlugins.includes(name)) return;
      try {
        await this.installPlugin(name, version);
      } catch(e) {
        if(e.code !== 'EEXIST') this.log('warn', `couldn't install ${name}, ${e.message}`);
      }
    }
  }
  async processPluginSchemas() {
    const installedPlugins = await this.find({});
    return Promise.all(installedPlugins.map(async p => {
      const cwd = `${this.framework.getPluginPath(p.type)}/${p.name}`;
      const pluginSchemas = await globPromise(`schema/*.schema.json`, { cwd, absolute: true });
      if(!pluginSchemas.length) {
        return;
      }
      const schemas = await Promise.all(pluginSchemas.map(s => fs.readJson(s)));
      schemas.forEach(s => {
        const source = s.$merge && s.$merge.source && s.$merge.source.$ref;
        if(source) {
          if(!this.pluginSchemas[p.name]) this.pluginSchemas[p.name] = {};
          if(!this.pluginSchemas[p.name][source]) this.pluginSchemas[p.name][source] = [];
          this.pluginSchemas[p.name][source].push(s);
        }
      });
    }));
  }
  getPluginExtensionSchemas(pluginName, sourceSchema) {
    const schemas = this.pluginSchemas[pluginName] && this.pluginSchemas[pluginName][sourceSchema];
    return schemas ? schemas : [];
  }
  /**
   * Express request handler for installing a plugin
   * @param {ClientRequest} req
   * @param {ServerResponse} res
   * @param {Function} next
   */
  async installHandler(req, res, next) {
    try {
      const pluginData = req.body.name ?
        await this.installPlugin(req.body.name) :
        await this.manualInstallPlugin(req.fileUpload.files.file.unzipPath, { isZip: false });
      res.status(this.mapStatusCode('post')).send(pluginData);
    } catch(error) {
      return next(error);
    }
  }
  /** @override */
  serveSchema() {
    return async (req, res, next) => {
      try {
        const plugin = await this.get({ name: req.apiData.query.type }) || {};
        const schema = await this.getSchema(plugin.schemaName);
        if(!schema) {
          const e = new Error('No schema found for plugin');
          e.statusCode = 404;
          return next(e);
        }
        res.type('application/schema+json').json(schema);
      } catch(e) {
        return next(e);
      }
    };
  }
  /**
   * Express request handler for updating a plugin
   * @param {ClientRequest} req
   * @param {ServerResponse} res
   * @param {Function} next
   */
  async updateHandler(req, res, next) {
    try {
      const pluginData = await this.updatePlugin(req.params._id);
      res.status(this.mapStatusCode('put')).send(pluginData);
    } catch(error) {
      return next(error);
    }
  }
  /**
   * Express request handler for removing a plugin
   * @param {ClientRequest} req
   * @param {ServerResponse} res
   * @param {Function} next
   */
  async uninstallHandler(req, res, next) {
    try {
      await this.uninstallPlugin(req.params._id);
      res.status(this.mapStatusCode('delete')).end();
    } catch(error) {
      return next(error);
    }
  }
  /**
   * Installs a new plugin
   * @param {String} plugin Plugin name
   * @param {String} version Version to install as a semver
   */
  async installPlugin(plugin, version) {
    const pluginStr = plugin + (version ? `@${version}` : '');
    const pluginData = this.addType(await this.runCliTask('install', pluginStr));
    return this.insertToDatabase(pluginData);
  }
  /**
   * Installs a new plugin from a zip file
   * @param {String} zipPath Path to the zip file
   * @param {Object} options Whether
   * @param {Boolean} options.isZip Whether the passed path points to a zip file
   */
  async manualInstallPlugin(zipPath, options = { isZip: true }) {
    let unzipPath;
    let pluginSrc = zipPath;
    try {
      if(options.isZip) {
        unzipPath = await zipper.unzip(zipPath);
        pluginSrc = `${unzipPath}/${path.basename(zipPath, '.zip')}`;
      }
      const pluginData = this.addType(await fs.readJson(`${pluginSrc}/bower.json`));
      const pluginPath = this.framework.getPluginPath(pluginData.type);
      const pluginDest = `${pluginPath}/${pluginData.name}`;

      pluginData.dir = pluginDest;

      await this.checkCompatibility(pluginData);

      if(pluginSrc !== pluginDest) await fs.move(pluginSrc, pluginDest, { overwrite: true });

      return this.insertToDatabase(pluginData);
    } catch(error) {
      try {
        if(options.isZip) await Promise.all([ fs.remove(unzipPath), fs.remove(pluginSrc) ]);
      } catch(removeError) {
        this.log('debug', removeError);
      }
      throw error;
    }
  }
  /**
   * Updates a single plugin
   * @param {String} _id The _id for the plugin to update
   */
  async updatePlugin(_id) {
    const installedPluginData = await this.getPluginById(_id);
    const pluginData = await this.runCliTask('update', installedPluginData.name);
    return this.replace({_id }, this.addType(pluginData));
  }
  /**
   * Removes a single plugin
   * @param {String} _id The _id for the plugin to remove
   */
  async uninstallPlugin(_id) {
    const pluginData = await this.getPluginById(_id);
    await this.delete({ _id });
    return this.runCliTask('uninstall', pluginData.name);
  }
  /**
   * Runs an adapt-cli task
   * @param {String} task Name of the CLI task to run
   * @param {String} plugin Name of the plugin on which to run the task
   */
  async runCliTask(task, plugin) {
    return cli[task](plugin, this.framework.path);
  }
  /**
   * Inserts plugin data to the database
   * @param {Object} pluginData The data to be inserted into the DB
   */
  async insertToDatabase(pluginData) {
    const [ existingData ] = await this.find({ name: pluginData.name });
    if(existingData) {
      return this.replace({ name: pluginData.name }, pluginData);
    }
    return this.insert(pluginData);
  }
  /**
   * Retrieves a the database doc for a single plugin
   * @param {String} _id The _id for the plugin to retrieve
   */
  async getPluginById(_id) {
    const [ pluginData ] = await this.find({ _id });
    return pluginData;
  }
  /**
   * Sets the plugin type for the passed plugin data
   * @param {Object} pluginData The data to modify
   * @return {Object} the modified plugin data
   */
  addType(pluginData) {
    if(!pluginData.type) {
      pluginData.type = Object.keys(pluginData).find(key => ['component', 'extension', 'menu', 'theme'].includes(key));
    }
    return pluginData;
  }
  /**
   * Checks that a plugin is compatible with the currently installed framework
   * @param {Object} pluginData
   * @param {String} pluginData.name
   * @param {String} pluginData.version
   * @param {String} pluginData.framework
   * @param {String} pluginData.targetAttribute
   */
  async checkCompatibility({ name, version, framework, targetAttribute }) {
    const [ installedPluginData ] = await this.find({ name });

    if(installedPluginData && semver.eq(installedPluginData.version, version)) {
      throw InstallError.EEXIST({ name, version });
    }
    if(!semver.satisfies(this.framework.version, framework)) {
      throw InstallError.EINCOMPAT({ name, version, requiredFramework: framework, installedFramework: this.framework.version });
    }
    if(targetAttribute) {
      const [ conflictingPlugin ] = await this.find({ targetAttribute, name: { $ne: name } });
      if(conflictingPlugin) throw InstallError.EATTRCLASH({ name: conflictingPlugin.name, targetAttribute });
    }
  }
}

class InstallError extends Error {
  static EEXIST({ name, version }) {
    return new InstallError(`Plugin ${name}@${version} already exists`, 'EEXIST');
  }
  static EINCOMPAT({ name, version, requiredFramework, installedFramework }) {
    return new InstallError(`Plugin ${name}@${version} incompatible with installed framework (requires ${requiredFramework}, found ${installedFramework})`, 'EINCOMPAT');
  }
  static EATTRCLASH({ name, targetAttribute }) {
    return new InstallError(`Target attribute '${targetAttribute}' already exists in ${name}`, 'EATTRCLASH');
  }
  constructor(message, code) {
    super(message);
    this.name = 'ContentPluginInstallError';
    this.code = code;
    this.statusCode = 400;
  }
}

module.exports = ContentPluginModule;
