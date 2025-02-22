import {NativePath, PortablePath, Filename}         from '@yarnpkg/fslib';
import {toFilename, npath, ppath}                   from '@yarnpkg/fslib';
import {PnpApi, PackageLocator, PackageInformation} from '@yarnpkg/pnp';

import {hoist, HoisterTree, HoisterResult}          from './hoist';

// Babel doesn't support const enums, thats why we use non-const enum for LinkType in @yarnpkg/pnp
// But because of this TypeScript requires @yarnpkg/pnp during runtime
// To prevent this we redeclare LinkType enum here, to not depend on @yarnpkg/pnp during runtime
export enum LinkType {HARD = 'HARD', SOFT = 'SOFT'};

/**
 * Node modules tree - a map of every folder within the node_modules, along with their
 * directory listing and whether they are a symlink and their location.
 *
 * Sample contents:
 * /home/user/project/node_modules -> {dirList: ['foo', 'bar']}
 * /home/user/project/node_modules/foo -> {target: '/home/user/project/.yarn/.cache/foo.zip/node_modules/foo', linkType: 'HARD'}
 * /home/user/project/node_modules/bar -> {target: '/home/user/project/packages/bar', linkType: 'SOFT'}
 */
export type NodeModulesTree = Map<PortablePath, {
  dirList: Set<Filename>
} | {
  dirList?: undefined,
  locator: LocatorKey,
  target: PortablePath,
  linkType: LinkType,
  aliases: string[],
}>;

export interface NodeModulesTreeOptions {
  pnpifyFs?: boolean;
}

/** node_modules path segment */
const NODE_MODULES = toFilename(`node_modules`);

/** Package locator key for usage inside maps */
type LocatorKey = string;

/**
 * Returns path to archive, if package location is inside the archive.
 *
 * @param packagePath package location
 *
 * @returns path to archive is location is insde the archive or null otherwise
 */
export const getArchivePath = (packagePath: PortablePath): PortablePath | null =>
  packagePath.indexOf(`.zip/${NODE_MODULES}/`) >= 0 ?
    npath.toPortablePath(packagePath.split(`/${NODE_MODULES}/`)[0]) :
    null;

/**
 * Retrieve full package list and build hoisted `node_modules` directories
 * representation in-memory.
 *
 * @param pnp PnP API
 *
 * @returns hoisted `node_modules` directories representation in-memory
 */
export const buildNodeModulesTree = (pnp: PnpApi, options: NodeModulesTreeOptions): NodeModulesTree => {
  const packageTree = buildPackageTree(pnp);

  const hoistedTree = hoist(packageTree, {finalCheck: false});

  return populateNodeModulesTree(pnp, hoistedTree, options);
};

const stringifyLocator = (locator: PackageLocator): LocatorKey => `${locator.name}@${locator.reference}`;

export type NodeModulesLocatorMap = Map<LocatorKey, {
  target: PortablePath;
  linkType: LinkType;
  locations: PortablePath[];
  aliases: string[];
}>

export const buildLocatorMap = (nodeModulesTree: NodeModulesTree): NodeModulesLocatorMap => {
  const map = new Map();

  for (const [location, val] of nodeModulesTree.entries()) {
    if (!val.dirList) {
      let entry = map.get(val.locator);
      if (!entry) {
        entry = {target: val.target, linkType: val.linkType, locations: [], aliases: val.aliases};
        map.set(val.locator, entry);
      }

      entry.locations.push(location);
    }
  }

  return map;
};

/**
 * Traverses PnP tree and produces input for the `RawHoister`
 *
 * @param pnp PnP API
 *
 * @returns package tree, packages info and locators
 */
const buildPackageTree = (pnp: PnpApi): HoisterTree => {
  const pnpRoots = pnp.getDependencyTreeRoots();

  const topPkg = pnp.getPackageInformation(pnp.topLevel)!;
  const topLocator = pnp.findPackageLocator(topPkg.packageLocation)!;
  const topLocatorKey = stringifyLocator(topLocator);
  for (const locator of pnpRoots) {
    if (stringifyLocator(locator) !== topLocatorKey) {
      topPkg.packageDependencies.set(`$wsroot$${locator.name!}`, locator.reference);
    }
  }

  const packageTree: HoisterTree = {
    name: topLocator.name!,
    reference: topLocator.reference!,
    peerNames: topPkg.packagePeers,
    dependencies: new Set<HoisterTree>(),
  };

  const nodes = new Map<LocatorKey, HoisterTree>();

  const addPackageToTree = (pkg: PackageInformation<NativePath>, locator: PackageLocator, parent: HoisterTree, parentPkg: PackageInformation<NativePath>) => {
    const locatorKey = stringifyLocator(locator);
    let node = nodes.get(locatorKey);
    const isSeen = !!node;
    if (locator === topLocator)
      node = packageTree;
    if (!node) {
      const {name, reference} = locator;

      // TODO: remove this code when `packagePeers` will not contain regular dependencies
      const peerNames = new Set<string>();
      for (const peerName of pkg.packagePeers)
        if (pkg.packageDependencies.get(peerName) === parentPkg.packageDependencies.get(peerName))
          peerNames.add(peerName);

      node = {
        name: name!,
        reference: reference!,
        dependencies: new Set(),
        peerNames,
      };
      nodes.set(locatorKey, node);
    }
    parent.dependencies.add(node);

    if (!isSeen) {
      for (const [name, referencish] of pkg.packageDependencies) {
        if (referencish !== null) {
          const depLocator = pnp.getLocator(name, referencish);
          const pkgLocator = pnp.getLocator(name.replace('$wsroot$', ''), referencish);
          const depPkg = pnp.getPackageInformation(pkgLocator)!;
          // Skip package self-references
          if (stringifyLocator(depLocator) !== locatorKey) {
            addPackageToTree(depPkg, depLocator, node, pkg);
          }
        }
      }
    }
  };

  addPackageToTree(topPkg, topLocator, packageTree, topPkg);

  return packageTree;
};


/**
 * Converts hoisted tree to node modules map
 *
 * @param pnp PnP API
 * @param hoistedTree hoisted package tree from `RawHoister`
 * @param locators locators
 * @param packages package weights
 *
 * @returns node modules map
 */
const populateNodeModulesTree = (pnp: PnpApi, hoistedTree: HoisterResult, options: NodeModulesTreeOptions): NodeModulesTree => {
  const tree: NodeModulesTree = new Map();

  const makeLeafNode = (locator: PackageLocator, aliases: string[]): {locator: LocatorKey, target: PortablePath, linkType: LinkType, aliases: string[]} => {
    const pkgLocator = pnp.getLocator(locator.name!.replace(/^\$wsroot\$/, ''), locator.reference!);
    const info = pnp.getPackageInformation(pkgLocator)!;

    let linkType;
    let target;
    if (options.pnpifyFs) {
      // In case of pnpifyFs we represent modules as symlinks to archives in NodeModulesFS
      // `/home/user/project/foo` is a symlink to `/home/user/project/.yarn/.cache/foo.zip/node_modules/foo`
      // To make this fs layout work with legacy tools we make
      // `/home/user/project/.yarn/.cache/foo.zip/node_modules/foo/node_modules` (which normally does not exist inside archive) a symlink to:
      // `/home/user/project/node_modules/foo/node_modules`, so that the tools were able to access it
      target = npath.toPortablePath(info.packageLocation);
      linkType = LinkType.SOFT;
    } else {
      const truePath = pnp.resolveVirtual && locator.reference && locator.reference.startsWith('virtual:') ? pnp.resolveVirtual(info.packageLocation) : info.packageLocation;
      target = npath.toPortablePath(truePath || info.packageLocation);
      linkType = info.linkType;
    }

    return {
      locator: stringifyLocator(locator),
      target,
      linkType,
      aliases,
    };
  };

  const getPackageName = (locator: PackageLocator): { name: Filename, scope: Filename | null } => {
    const [nameOrScope, name] = locator.name!.split('/');
    return name ? {scope: toFilename(nameOrScope), name: toFilename(name)} : {scope: null, name: toFilename(nameOrScope)};
  };

  const seenNodes = new Set<HoisterResult>();
  const buildTree = (pkg: HoisterResult, locationPrefix: PortablePath) => {
    if (seenNodes.has(pkg))
      return;
    seenNodes.add(pkg);
    for (const dep of pkg.dependencies) {
      const references: string[] = Array.from(dep.references).sort();
      const locator = {name: dep.name, reference: references[0]};
      const {name, scope} = getPackageName(locator);

      const packageNameParts = scope ? [scope, name] : [name];

      const nodeModulesDirPath = ppath.join(locationPrefix, NODE_MODULES);
      const nodeModulesLocation = ppath.join(nodeModulesDirPath, ...packageNameParts);

      const leafNode = makeLeafNode(locator, references.slice(1));
      if (!dep.name.startsWith('$wsroot$')) {
        tree.set(nodeModulesLocation, leafNode);

        const segments = nodeModulesLocation.split('/');
        const nodeModulesIdx = segments.indexOf(NODE_MODULES);

        let segCount = segments.length - 1;
        while (nodeModulesIdx >= 0 && segCount > nodeModulesIdx) {
          const dirPath = npath.toPortablePath(segments.slice(0, segCount).join(ppath.sep));
          const targetDir = toFilename(segments[segCount]);

          const subdirs = tree.get(dirPath);
          if (!subdirs) {
            tree.set(dirPath, {dirList: new Set([targetDir])});
          } else if (subdirs.dirList) {
            if (subdirs.dirList.has(targetDir)) {
              break;
            } else {
              subdirs.dirList.add(targetDir);
            }
          }

          segCount--;
        }
      }

      buildTree(dep, leafNode.linkType === LinkType.SOFT ? leafNode.target: nodeModulesLocation);
    }
  };

  const rootNode = makeLeafNode({name: hoistedTree.name, reference: Array.from(hoistedTree.references)[0] as string}, []);
  const rootPath = rootNode.target;
  tree.set(rootPath, rootNode);
  buildTree(hoistedTree, rootPath);

  return tree;
};

/**
 * Benchmarks raw hoisting performance.
 *
 * The function is used for troubleshooting purposes only.
 *
 * @param packageTree package tree
 * @param packages package info
 *
 * @returns average raw hoisting time
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const benchmarkRawHoisting = (packageTree: HoisterTree) => {
  const iterCount = 10;
  const startTime = Date.now();
  for (let iter = 0; iter < iterCount; iter++)
    hoist(packageTree);
  const endTime = Date.now();
  return (endTime - startTime) / iterCount;
};

/**
 * Benchmarks node_modules tree building.
 *
 * The function is used for troubleshooting purposes only.
 *
 * @param packageTree package tree
 * @param packages package info
 *
 * @returns average raw hoisting time
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const benchmarkBuildTree = (pnp: PnpApi, options: NodeModulesTreeOptions): number => {
  const iterCount = 100;
  const startTime = Date.now();
  for (let iter = 0; iter < iterCount; iter++) {
    const packageTree = buildPackageTree(pnp);
    const hoistedTree = hoist(packageTree);
    populateNodeModulesTree(pnp, hoistedTree, options);
  }
  const endTime = Date.now();
  return (endTime - startTime) / iterCount;
};

/**
 * Pretty-prints node_modules tree.
 *
 * The function is used for troubleshooting purposes only.
 *
 * @param tree node_modules tree
 * @param rootPath top-level project root folder
 *
 * @returns sorted node_modules tree
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const dumpNodeModulesTree = (tree: NodeModulesTree, rootPath: PortablePath): string => {
  const sortedTree: NodeModulesTree = new Map();

  const keys = Array.from(tree.keys()).sort();
  for (const key of keys) {
    const val = tree.get(key)!;
    sortedTree.set(key, val.dirList ? {dirList: new Set(Array.from(val.dirList).sort())} : val);
  }

  const seenPaths = new Set();
  const dumpTree = (nodePath: PortablePath, prefix: string = '', dirPrefix = ''): string => {
    const node = sortedTree.get(nodePath);
    if (!node)
      return '';
    seenPaths.add(nodePath);
    let str = '';
    if (node.dirList) {
      const dirs = Array.from(node.dirList);
      for (let idx = 0; idx < dirs.length; idx++) {
        const dir = dirs[idx];
        str += `${prefix}${idx < dirs.length - 1 ? '├─' : '└─'}${dirPrefix}${dir}\n`;
        str += dumpTree(ppath.join(nodePath, dir), `${prefix}${idx < dirs.length - 1 ?'│ ' : '  '}`);
      }
    } else {
      const {target, linkType} = node;
      str += dumpTree(ppath.join(nodePath, NODE_MODULES), `${prefix}│ `, `${NODE_MODULES}/`);
      str += `${prefix}└─${linkType === LinkType.SOFT ? 's>' : '>'}${target}\n`;
    }
    return str;
  };

  let str = dumpTree(ppath.join(rootPath, NODE_MODULES));
  for (const key of sortedTree.keys()) {
    if (!seenPaths.has(key)) {
      str += `${key.replace(rootPath, '')}\n${dumpTree(key)}`;
    }
  }
  return str;
};

/**
 * Pretty-prints dependency tree in the `yarn why`-like format
 *
 * The function is used for troubleshooting purposes only.
 *
 * @param pkg node_modules tree
 *
 * @returns sorted node_modules tree
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const dumpDepTree = (tree: HoisterResult) => {
  const dumpLocator = (locator: PackageLocator): string => {
    if (locator.reference === 'workspace:.') {
      return '.';
    } else if (!locator.reference) {
      return `${locator.name!}@${locator.reference}`;
    } else {
      const version = (locator.reference.indexOf('#') > 0 ? locator.reference.split('#')[1] : locator.reference).replace('npm:', '');
      if (locator.reference.startsWith('virtual')) {
        return `v:${locator.name!}@${version}`;
      } else {
        return `${locator.name!}@${version}`;
      }
    }
  };

  const dumpPackage = (pkg: HoisterResult, parents: HoisterResult[], prefix = ''): string => {
    if (parents.includes(pkg))
      return '';

    const dependencies = Array.from(pkg.dependencies);

    let str = '';
    for (let idx = 0; idx < dependencies.length; idx++) {
      const dep = dependencies[idx];
      str += `${prefix}${idx < dependencies.length - 1 ? '├─' : '└─'}${(parents.includes(dep) ? '>' : '') + dumpLocator({name: dep.name, reference: Array.from(dep.references)[0]})}\n`;
      str += dumpPackage(dep, [...parents, dep], `${prefix}${idx < dependencies.length - 1 ?'│ ' : '  '}`);
    }
    return str;
  };

  return dumpPackage(tree, []);
};
