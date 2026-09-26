#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');

export const TOOL_CATALOG_SOURCE_PATH = join(REPO_ROOT, 'tool-definitions.json');
export const PLATFORM_TOOL_CATALOG_PATH = join(REPO_ROOT, 'platform-tool-catalog.generated.ts');

const README_PATH = join(REPO_ROOT, 'README.md');
const AI_TOOLS_DOC_PATH = join(REPO_ROOT, 'docs', 'ai-tools.md');
const AGENTS_TEMPLATE_PATH = join(REPO_ROOT, 'runtime', 'templates', 'AGENTS.md.template');
const ARTIFACT_HASH_PLACEHOLDER = '0'.repeat(64);
// The platform reads the provenance through these exact patterns and requires each once.
const SCHEMA_VERSION = 2;
const SCHEMA_VERSION_PATTERN = /schemaVersion: ([0-9]+),/g;
const SOURCE_HASH_PATTERN = /sourceContentSha256: '([0-9a-f]{64})'/g;
const ARTIFACT_HASH_PATTERN = /artifactContentSha256: '([0-9a-f]{64})'/g;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type FillRule = 'evenodd' | 'nonzero';
type StrokeLinecap = 'butt' | 'round' | 'square' | 'inherit';
type StrokeLinejoin = 'miter' | 'round' | 'bevel' | 'inherit';

interface ToolIconPath {
  type: 'path';
  d: string;
  fill?: string;
  fillRule?: FillRule;
  clipRule?: FillRule;
  stroke?: string;
  strokeWidth?: string;
  strokeLinecap?: StrokeLinecap;
  strokeLinejoin?: StrokeLinejoin;
  transform?: string;
}

interface ToolIconRect {
  type: 'rect';
  x?: string;
  y?: string;
  width: string;
  height: string;
  rx?: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: string;
  transform?: string;
}

interface ToolIconCircle {
  type: 'circle';
  cx: string;
  cy: string;
  r: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: string;
  transform?: string;
}

interface ToolIconGroup {
  type: 'group';
  transform: string;
  children: ToolIconPrimitive[];
}

type ToolIconPrimitive = ToolIconPath | ToolIconRect | ToolIconCircle | ToolIconGroup;

interface ToolIconGradientStop {
  offset?: string;
  stopColor: string;
  stopOpacity?: string;
}

interface ToolIconGradient {
  x1: string;
  y1: string;
  x2: string;
  y2: string;
  gradientUnits?: 'userSpaceOnUse';
  stops: ToolIconGradientStop[];
}

interface ToolIcon {
  viewBox: string;
  fill: string;
  fillRule?: FillRule;
  gradient?: ToolIconGradient;
  primitives: ToolIconPrimitive[];
}

interface PlatformTool {
  id: string;
  name: string;
  command: string;
  authCommand: string | null;
  description: string;
  docsUrl: string;
  envVars: string[];
  authSummary: string;
}

interface EnvVarMeta {
  placeholder: string;
  hint: string;
  url: string | null;
}

interface PlatformCatalog {
  tools: PlatformTool[];
  icons: Record<string, ToolIcon>;
  envVarMeta: Record<string, EnvVarMeta>;
}

export interface GeneratedPlatformToolCatalog {
  content: string;
  sourceContentSha256: string;
  artifactContentSha256: string;
}

interface DocumentationSection {
  name: string;
  content: string;
}

interface DocumentationFile {
  path: string;
  sections: DocumentationSection[];
}

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Catalog JSON contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  throw new Error(`Catalog contains unsupported JSON value: ${typeof value}`);
}

export function canonicalContentSha256(value: JsonValue): string {
  return sha256(canonicalJson(value));
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${label} has unsupported field ${JSON.stringify(unknown)}`);
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function optionalStringField(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return stringField(value, label);
}

function nullableStringField(value: unknown, label: string): string | null {
  if (value === null) return null;
  return stringField(value, label);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${label} contains duplicate values`);
  return [...value];
}

function fillRule(value: unknown, label: string): FillRule | undefined {
  const parsed = optionalStringField(value, label);
  if (parsed !== undefined && parsed !== 'evenodd' && parsed !== 'nonzero') {
    throw new Error(`${label} must be "evenodd" or "nonzero"`);
  }
  return parsed;
}

function strokeLinecap(value: unknown, label: string): StrokeLinecap | undefined {
  const parsed = optionalStringField(value, label);
  if (parsed !== undefined && parsed !== 'butt' && parsed !== 'round' && parsed !== 'square' && parsed !== 'inherit') {
    throw new Error(`${label} has an unsupported value`);
  }
  return parsed;
}

function strokeLinejoin(value: unknown, label: string): StrokeLinejoin | undefined {
  const parsed = optionalStringField(value, label);
  if (parsed !== undefined && parsed !== 'miter' && parsed !== 'round' && parsed !== 'bevel' && parsed !== 'inherit') {
    throw new Error(`${label} has an unsupported value`);
  }
  return parsed;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

function iconPrimitive(value: unknown, label: string): ToolIconPrimitive {
  const primitive = record(value, label);
  const type = stringField(primitive.type, `${label}.type`);
  if (type === 'path') {
    exactFields(primitive, [
      'type', 'd', 'fill', 'fillRule', 'clipRule', 'stroke', 'strokeWidth',
      'strokeLinecap', 'strokeLinejoin', 'transform',
    ], label);
    return compact({
      type: 'path' as const,
      d: stringField(primitive.d, `${label}.d`),
      fill: optionalStringField(primitive.fill, `${label}.fill`),
      fillRule: fillRule(primitive.fillRule, `${label}.fillRule`),
      clipRule: fillRule(primitive.clipRule, `${label}.clipRule`),
      stroke: optionalStringField(primitive.stroke, `${label}.stroke`),
      strokeWidth: optionalStringField(primitive.strokeWidth, `${label}.strokeWidth`),
      strokeLinecap: strokeLinecap(primitive.strokeLinecap, `${label}.strokeLinecap`),
      strokeLinejoin: strokeLinejoin(primitive.strokeLinejoin, `${label}.strokeLinejoin`),
      transform: optionalStringField(primitive.transform, `${label}.transform`),
    });
  }
  if (type === 'rect') {
    exactFields(primitive, [
      'type', 'x', 'y', 'width', 'height', 'rx', 'fill', 'stroke', 'strokeWidth', 'transform',
    ], label);
    return compact({
      type: 'rect' as const,
      x: optionalStringField(primitive.x, `${label}.x`),
      y: optionalStringField(primitive.y, `${label}.y`),
      width: stringField(primitive.width, `${label}.width`),
      height: stringField(primitive.height, `${label}.height`),
      rx: optionalStringField(primitive.rx, `${label}.rx`),
      fill: optionalStringField(primitive.fill, `${label}.fill`),
      stroke: optionalStringField(primitive.stroke, `${label}.stroke`),
      strokeWidth: optionalStringField(primitive.strokeWidth, `${label}.strokeWidth`),
      transform: optionalStringField(primitive.transform, `${label}.transform`),
    });
  }
  if (type === 'circle') {
    exactFields(primitive, ['type', 'cx', 'cy', 'r', 'fill', 'stroke', 'strokeWidth', 'transform'], label);
    return compact({
      type: 'circle' as const,
      cx: stringField(primitive.cx, `${label}.cx`),
      cy: stringField(primitive.cy, `${label}.cy`),
      r: stringField(primitive.r, `${label}.r`),
      fill: optionalStringField(primitive.fill, `${label}.fill`),
      stroke: optionalStringField(primitive.stroke, `${label}.stroke`),
      strokeWidth: optionalStringField(primitive.strokeWidth, `${label}.strokeWidth`),
      transform: optionalStringField(primitive.transform, `${label}.transform`),
    });
  }
  if (type === 'group') {
    exactFields(primitive, ['type', 'transform', 'children'], label);
    if (!Array.isArray(primitive.children) || primitive.children.length === 0) {
      throw new Error(`${label}.children must be a non-empty array`);
    }
    return {
      type,
      transform: stringField(primitive.transform, `${label}.transform`),
      children: primitive.children.map((child, index) => iconPrimitive(child, `${label}.children[${index}]`)),
    };
  }
  throw new Error(`${label} has unsupported icon primitive type ${JSON.stringify(type)}`);
}

function iconGradient(value: unknown, label: string): ToolIconGradient | undefined {
  if (value === undefined) return undefined;
  const gradient = record(value, label);
  exactFields(gradient, ['x1', 'y1', 'x2', 'y2', 'gradientUnits', 'stops'], label);
  const gradientUnits = optionalStringField(gradient.gradientUnits, `${label}.gradientUnits`);
  if (gradientUnits !== undefined && gradientUnits !== 'userSpaceOnUse') {
    throw new Error(`${label}.gradientUnits must be "userSpaceOnUse"`);
  }
  if (!Array.isArray(gradient.stops) || gradient.stops.length === 0) {
    throw new Error(`${label}.stops must be a non-empty array`);
  }
  return compact({
    x1: stringField(gradient.x1, `${label}.x1`),
    y1: stringField(gradient.y1, `${label}.y1`),
    x2: stringField(gradient.x2, `${label}.x2`),
    y2: stringField(gradient.y2, `${label}.y2`),
    gradientUnits,
    stops: gradient.stops.map((value, index) => {
      const stop = record(value, `${label}.stops[${index}]`);
      exactFields(stop, ['offset', 'stopColor', 'stopOpacity'], `${label}.stops[${index}]`);
      return compact({
        offset: optionalStringField(stop.offset, `${label}.stops[${index}].offset`),
        stopColor: stringField(stop.stopColor, `${label}.stops[${index}].stopColor`),
        stopOpacity: optionalStringField(stop.stopOpacity, `${label}.stops[${index}].stopOpacity`),
      });
    }),
  }) as ToolIconGradient;
}

function usesGradient(primitives: ToolIconPrimitive[]): boolean {
  return primitives.some((primitive) => {
    if (primitive.type === 'group') return usesGradient(primitive.children);
    return primitive.fill === '$gradient' || primitive.stroke === '$gradient';
  });
}

function toolIcon(value: unknown, label: string): ToolIcon {
  const icon = record(value, label);
  exactFields(icon, ['viewBox', 'fill', 'fillRule', 'gradient', 'primitives'], label);
  if (!Array.isArray(icon.primitives) || icon.primitives.length === 0) {
    throw new Error(`${label}.primitives must be a non-empty array`);
  }
  const primitives = icon.primitives.map((value, index) => iconPrimitive(value, `${label}.primitives[${index}]`));
  const gradient = iconGradient(icon.gradient, `${label}.gradient`);
  if (usesGradient(primitives) !== (gradient !== undefined)) {
    throw new Error(`${label} must define exactly one used linear gradient`);
  }
  return compact({
    viewBox: stringField(icon.viewBox, `${label}.viewBox`),
    fill: stringField(icon.fill, `${label}.fill`),
    fillRule: fillRule(icon.fillRule, `${label}.fillRule`),
    gradient,
    primitives,
  });
}

export function projectPlatformCatalog(source: unknown): PlatformCatalog {
  const root = record(source, 'tool-definitions.json');
  if (!Array.isArray(root.tools) || root.tools.length === 0) {
    throw new Error('tool-definitions.json.tools must be a non-empty array');
  }

  const ids = new Set<string>();
  const icons: Record<string, ToolIcon> = {};
  const tools = root.tools.map((value, index): PlatformTool => {
    const tool = record(value, `tools[${index}]`);
    const id = stringField(tool.id, `tools[${index}].id`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error(`tools[${index}].id is not a lowercase slug`);
    if (ids.has(id)) throw new Error(`Duplicate tool id: ${id}`);
    ids.add(id);

    const command = stringField(tool.command, `tools[${index}].command`);
    if (!/^[A-Za-z0-9._+-]+$/.test(command)) {
      throw new Error(`tools[${index}].command must be a bare executable name`);
    }
    icons[id] = toolIcon(tool.icon, `tools[${index}].icon`);
    return {
      id,
      name: stringField(tool.name, `tools[${index}].name`),
      command,
      authCommand: nullableStringField(tool.authCommand, `tools[${index}].authCommand`),
      description: stringField(tool.description, `tools[${index}].description`),
      docsUrl: stringField(tool.docsUrl, `tools[${index}].docsUrl`),
      envVars: stringArray(tool.envVars, `tools[${index}].envVars`),
      authSummary: stringField(tool.authSummary, `tools[${index}].authSummary`),
    };
  });

  const sourceMeta = record(root.envVarMeta, 'tool-definitions.json.envVarMeta');
  const envVarMeta = Object.fromEntries(
    Object.keys(sourceMeta)
      .sort()
      .map((name) => {
        const metadata = record(sourceMeta[name], `envVarMeta.${name}`);
        exactFields(metadata, ['placeholder', 'hint', 'url'], `envVarMeta.${name}`);
        return [name, {
          placeholder: stringField(metadata.placeholder, `envVarMeta.${name}.placeholder`),
          hint: stringField(metadata.hint, `envVarMeta.${name}.hint`),
          url: nullableStringField(metadata.url, `envVarMeta.${name}.url`),
        }];
      }),
  );

  for (const tool of tools) {
    for (const name of tool.envVars) {
      if (!Object.hasOwn(envVarMeta, name)) throw new Error(`${tool.id} references missing envVarMeta.${name}`);
    }
  }
  return { tools, icons, envVarMeta };
}

function renderArtifact(
  catalog: PlatformCatalog,
  sourceContentSha256: string,
  artifactContentSha256: string,
): string {
  return `// Generated by dev/scripts/platform-tool-catalog.ts from tool-definitions.json. DO NOT EDIT.
// sourceContentSha256 addresses recursively key-sorted source JSON; it is not a Git revision or image digest.
// artifactContentSha256 addresses these UTF-8 bytes with its own 64 hex characters replaced by zeroes.

export const TOOL_CATALOG_PROVENANCE = {
  schemaVersion: ${SCHEMA_VERSION},
  sourceContentSha256: '${sourceContentSha256}',
  artifactContentSha256: '${artifactContentSha256}',
} as const

export const AI_TOOLS = ${JSON.stringify(catalog.tools, null, 2)} as const

export type ToolId = (typeof AI_TOOLS)[number]['id']

export interface ToolIconPath {
  readonly type: 'path'
  readonly d: string
  readonly fill?: string
  readonly fillRule?: 'evenodd' | 'nonzero'
  readonly clipRule?: 'evenodd' | 'nonzero'
  readonly stroke?: string
  readonly strokeWidth?: string
  readonly strokeLinecap?: 'butt' | 'round' | 'square' | 'inherit'
  readonly strokeLinejoin?: 'miter' | 'round' | 'bevel' | 'inherit'
  readonly transform?: string
}

export interface ToolIconRect {
  readonly type: 'rect'
  readonly x?: string
  readonly y?: string
  readonly width: string
  readonly height: string
  readonly rx?: string
  readonly fill?: string
  readonly stroke?: string
  readonly strokeWidth?: string
  readonly transform?: string
}

export interface ToolIconCircle {
  readonly type: 'circle'
  readonly cx: string
  readonly cy: string
  readonly r: string
  readonly fill?: string
  readonly stroke?: string
  readonly strokeWidth?: string
  readonly transform?: string
}

export interface ToolIconGroup {
  readonly type: 'group'
  readonly transform: string
  readonly children: readonly ToolIconPrimitive[]
}

export type ToolIconPrimitive = ToolIconPath | ToolIconRect | ToolIconCircle | ToolIconGroup

export interface ToolIconData {
  readonly viewBox: string
  readonly fill: string
  readonly fillRule?: 'evenodd' | 'nonzero'
  readonly gradient?: {
    readonly x1: string
    readonly y1: string
    readonly x2: string
    readonly y2: string
    readonly gradientUnits?: 'userSpaceOnUse'
    readonly stops: readonly {
      readonly offset?: string
      readonly stopColor: string
      readonly stopOpacity?: string
    }[]
  }
  readonly primitives: readonly ToolIconPrimitive[]
}

export const AI_TOOL_ICONS = ${JSON.stringify(catalog.icons, null, 2)} as const satisfies Readonly<Record<ToolId, ToolIconData>>

export const AI_ENV_VAR_META = ${JSON.stringify(catalog.envVarMeta, null, 2)} as const
`;
}

function parseSource(sourceText: string): { source: JsonValue; catalog: PlatformCatalog } {
  let source: JsonValue;
  try {
    source = JSON.parse(sourceText) as JsonValue;
  } catch (error) {
    throw new Error(`Invalid tool-definitions.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { source, catalog: projectPlatformCatalog(source) };
}

export function generatePlatformToolCatalog(sourceText: string): GeneratedPlatformToolCatalog {
  const { source, catalog } = parseSource(sourceText);
  const sourceContentSha256 = canonicalContentSha256(source);
  const unhashed = renderArtifact(catalog, sourceContentSha256, ARTIFACT_HASH_PLACEHOLDER);
  const artifactContentSha256 = sha256(unhashed);
  const content = renderArtifact(catalog, sourceContentSha256, artifactContentSha256);
  validateGeneratedArtifact(content);
  return { content, sourceContentSha256, artifactContentSha256 };
}

export function validateGeneratedArtifact(content: string): string {
  const versions = [...content.matchAll(SCHEMA_VERSION_PATTERN)];
  if (versions.length !== 1 || Number(versions[0][1]) !== SCHEMA_VERSION) {
    throw new Error(`Generated artifact must contain exactly one schemaVersion: ${SCHEMA_VERSION}`);
  }
  if ([...content.matchAll(SOURCE_HASH_PATTERN)].length !== 1) {
    throw new Error('Generated artifact must contain exactly one sourceContentSha256');
  }

  const matches = [...content.matchAll(ARTIFACT_HASH_PATTERN)];
  if (matches.length !== 1) throw new Error('Generated artifact must contain exactly one artifactContentSha256');

  const embedded = matches[0][1];
  const zeroed = content.replace(ARTIFACT_HASH_PATTERN, `artifactContentSha256: '${ARTIFACT_HASH_PLACEHOLDER}'`);
  const actual = sha256(zeroed);
  if (actual !== embedded) {
    throw new Error(`Generated artifact content hash is ${actual}, expected ${embedded}`);
  }
  return embedded;
}

function markdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function toolTable(catalog: PlatformCatalog, includeDescription: boolean): string {
  const header = includeDescription
    ? '| Tool | Command | Description | Authentication |\n|------|---------|-------------|----------------|'
    : '| Tool | Command | Authentication |\n|------|---------|----------------|';
  const rows = catalog.tools.map((tool) => {
    const cells = [
      `**[${markdownCell(tool.name)}](${tool.docsUrl})**`,
      `\`${tool.command}\``,
      ...(includeDescription ? [markdownCell(tool.description)] : []),
      markdownCell(tool.authSummary),
    ];
    return `| ${cells.join(' | ')} |`;
  });
  return `${header}\n${rows.join('\n')}`;
}

function environmentTable(catalog: PlatformCatalog): string {
  const rows = Object.keys(catalog.envVarMeta).map((name) => {
    const tools = catalog.tools.filter((tool) => tool.envVars.includes(name));
    if (tools.length === 0) throw new Error(`envVarMeta.${name} is not used by any tool`);
    return `| \`${name}\` | ${tools.map((tool) => tool.name).join(', ')} |`;
  });
  return `| Variable | Tools |\n|----------|-------|\n${rows.join('\n')}`;
}

export function generateToolDocumentation(sourceText: string): DocumentationFile[] {
  const { catalog } = parseSource(sourceText);
  const count = catalog.tools.length;
  return [
    {
      path: README_PATH,
      sections: [{
        name: 'TOOL CATALOG',
        content: `The image includes ${count} AI coding agents.\n\n${toolTable(catalog, true)}`,
      }],
    },
    {
      path: AI_TOOLS_DOC_PATH,
      sections: [
        {
          name: 'TOOL CATALOG',
          content: `EnvHaven includes ${count} CLI-based AI agents.\n\n${toolTable(catalog, true)}`,
        },
        { name: 'TOOL ENVIRONMENT VARIABLES', content: environmentTable(catalog) },
      ],
    },
    {
      path: AGENTS_TEMPLATE_PATH,
      sections: [{
        name: 'TOOL CATALOG',
        content: `${count} AI coding tools are pre-installed. Most require authentication.\n\n${toolTable(catalog, false)}`,
      }],
    },
  ];
}

function markedSection(section: DocumentationSection): string {
  return `<!-- BEGIN GENERATED: ${section.name} -->\n${section.content}\n<!-- END GENERATED: ${section.name} -->`;
}

function replaceMarkedSection(content: string, section: DocumentationSection, path: string): string {
  const begin = `<!-- BEGIN GENERATED: ${section.name} -->`;
  const end = `<!-- END GENERATED: ${section.name} -->`;
  const beginAt = content.indexOf(begin);
  const endAt = content.indexOf(end);
  if (beginAt < 0 || endAt < 0 || endAt < beginAt || content.indexOf(begin, beginAt + 1) >= 0 || content.indexOf(end, endAt + 1) >= 0) {
    throw new Error(`${path} must contain exactly one ordered ${section.name} marker pair`);
  }
  return content.slice(0, beginAt) + markedSection(section) + content.slice(endAt + end.length);
}

function expectedDocumentationFiles(sourceText: string): { path: string; actual: string; expected: string }[] {
  return generateToolDocumentation(sourceText).map(({ path, sections }) => {
    const actual = readFileSync(path, 'utf8');
    const expected = sections.reduce((content, section) => replaceMarkedSection(content, section, path), actual);
    return { path, actual, expected };
  });
}

export function writeGeneratedDocumentation(sourceText = readFileSync(TOOL_CATALOG_SOURCE_PATH, 'utf8')): number {
  const files = expectedDocumentationFiles(sourceText);
  for (const file of files) writeFileSync(file.path, file.expected);
  return files.reduce((count, file) => count + generateToolDocumentation(sourceText).find((entry) => entry.path === file.path)!.sections.length, 0);
}

export function checkGeneratedDocumentation(sourceText = readFileSync(TOOL_CATALOG_SOURCE_PATH, 'utf8')): number {
  const files = expectedDocumentationFiles(sourceText);
  const stale = files.filter((file) => file.actual !== file.expected);
  if (stale.length > 0) {
    throw new Error(`Stale generated tool documentation: ${stale.map((file) => file.path).join(', ')}; run this script with --write`);
  }
  return generateToolDocumentation(sourceText).reduce((count, file) => count + file.sections.length, 0);
}

export function expectedPlatformToolCatalog(): GeneratedPlatformToolCatalog {
  return generatePlatformToolCatalog(readFileSync(TOOL_CATALOG_SOURCE_PATH, 'utf8'));
}

export function checkPlatformToolCatalog(): GeneratedPlatformToolCatalog {
  const expected = expectedPlatformToolCatalog();
  let actual: string;
  try {
    actual = readFileSync(PLATFORM_TOOL_CATALOG_PATH, 'utf8');
  } catch {
    throw new Error(`Missing ${PLATFORM_TOOL_CATALOG_PATH}; run this script with --write`);
  }
  validateGeneratedArtifact(actual);
  if (actual !== expected.content) {
    throw new Error(`Stale ${PLATFORM_TOOL_CATALOG_PATH}; run this script with --write`);
  }
  return expected;
}

function usage(): never {
  throw new Error(
    'Usage: bun dev/scripts/platform-tool-catalog.ts --write [output] | --check | --print-hash | --print-source-hash',
  );
}

if (import.meta.main) {
  try {
    const [mode, output, ...extra] = process.argv.slice(2);
    if (extra.length > 0 || (mode !== '--write' && output !== undefined)) usage();

    if (mode === '--write') {
      const generated = expectedPlatformToolCatalog();
      const outputPath = output ?? PLATFORM_TOOL_CATALOG_PATH;
      writeFileSync(outputPath, generated.content);
      const docs = output === undefined ? writeGeneratedDocumentation() : 0;
      console.log(`Wrote ${outputPath} (${generated.artifactContentSha256})${docs ? ` and ${docs} documentation sections` : ''}`);
    } else if (mode === '--check') {
      const generated = checkPlatformToolCatalog();
      const docs = checkGeneratedDocumentation();
      console.log(`Platform tool catalog and ${docs} documentation sections are current (${generated.artifactContentSha256})`);
    } else if (mode === '--print-hash') {
      console.log(expectedPlatformToolCatalog().artifactContentSha256);
    } else if (mode === '--print-source-hash') {
      console.log(expectedPlatformToolCatalog().sourceContentSha256);
    } else {
      usage();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
