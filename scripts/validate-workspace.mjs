import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import process from 'node:process';

const root = process.cwd();
const workspaceRoots = ['apps', 'packages'];
// Packages intentionally published to npm: exempt from the private/0.0.0 guard
// (they carry a real semver version and `publishConfig.access`), but still held
// to ESM and the workspace:* internal-dependency rules below.
const publishablePackages = new Set(['baton-cloud']);
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const dependencyFields = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];
const errors = [];

async function directories(path) {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(path, entry.name));
  } catch {
    return [];
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    errors.push(`${relative(root, path)}: ${error.message}`);
    return undefined;
  }
}

async function sourceFiles(path) {
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (
      entry.name === 'dist' ||
      entry.name === 'node_modules' ||
      entry.name === '.turbo'
    ) {
      continue;
    }
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(child)));
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
      files.push(child);
    }
  }
  return files;
}

const workspaceDirectories = (
  await Promise.all(workspaceRoots.map((path) => directories(join(root, path))))
).flat();

const workspaces = [];
for (const directory of workspaceDirectories) {
  const manifestPath = join(directory, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      errors.push(`${relative(root, manifestPath)}: ${error.message}`);
    }
    continue;
  }
  workspaces.push({ directory, manifest, manifestPath });
}

const names = new Map();
for (const workspace of workspaces) {
  const label = relative(root, workspace.directory);
  const { manifest } = workspace;
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    errors.push(`${label}: package name is required`);
  } else if (names.has(manifest.name)) {
    errors.push(
      `${label}: duplicate package name ${manifest.name} (also in ${names.get(manifest.name)})`,
    );
  } else {
    names.set(manifest.name, label);
  }
  if (publishablePackages.has(manifest.name)) {
    if (manifest.private === true) {
      errors.push(`${label}: publishable package must not be private`);
    }
    if (
      typeof manifest.version !== 'string' ||
      !semver.test(manifest.version)
    ) {
      errors.push(`${label}: publishable package needs a semver version`);
    }
    if (manifest.publishConfig?.access !== 'public') {
      errors.push(`${label}: publishable package needs publishConfig.access`);
    }
  } else {
    if (manifest.private !== true) {
      errors.push(`${label}: workspace packages must be private`);
    }
    if (manifest.version !== '0.0.0') {
      errors.push(`${label}: workspace version must be 0.0.0 before release`);
    }
  }
  if (manifest.type !== 'module') {
    errors.push(`${label}: workspace packages must use ESM`);
  }
}

const workspaceNames = new Set(names.keys());
const appNames = new Set(
  workspaces
    .filter(({ directory }) =>
      relative(root, directory).startsWith(`apps${sep}`),
    )
    .map(({ manifest }) => manifest.name),
);

for (const workspace of workspaces) {
  const label = relative(root, workspace.directory);
  for (const field of dependencyFields) {
    for (const [name, version] of Object.entries(
      workspace.manifest[field] ?? {},
    )) {
      if (workspaceNames.has(name) && version !== 'workspace:*') {
        errors.push(
          `${label}: internal dependency ${name} must use workspace:*`,
        );
      }
      if (appNames.has(name)) {
        errors.push(
          `${label}: applications cannot be imported as dependencies`,
        );
      }
    }
  }

  for (const file of await sourceFiles(workspace.directory)) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(
      /(?:from\s+|import\s*\(|require\s*\()\s*['"](@baton\/[^'"]+)['"]/g,
    )) {
      const specifier = match[1];
      const segments = specifier.split('/');
      if (segments.length > 2) {
        errors.push(
          `${relative(root, file)}: deep workspace import ${specifier} is forbidden`,
        );
      }
      if (appNames.has(specifier)) {
        errors.push(
          `${relative(root, file)}: importing application ${specifier} is forbidden`,
        );
      }
    }
  }
}

// Parse root contracts/configs that must remain valid JSON. This catches
// malformed edits before Turbo or a deployment tool produces a vague error.
for (const path of [
  'package.json',
  'turbo.json',
  'tsconfig.base.json',
  '.prettierrc.json',
]) {
  await readJson(join(root, path));
}

if (errors.length > 0) {
  console.error('Workspace validation failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Workspace validation passed (${workspaces.length} package).`);
}
