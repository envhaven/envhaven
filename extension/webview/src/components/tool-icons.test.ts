import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AI_TOOL_ICONS } from '../../../../platform-tool-catalog.generated';
import { ToolIcon, iconMap } from './tool-icons';
import toolDefinitions from '../../../../tool-definitions.json';

describe('tool icons', () => {
  test('cover the catalogue exactly, in both directions', () => {
    const catalogue = toolDefinitions.tools.map((t) => t.id).sort();
    expect(Object.keys(iconMap).sort()).toEqual(catalogue);
    expect(Object.keys(AI_TOOL_ICONS).sort()).toEqual(catalogue);
  });

  test('keeps branded and fallback artwork decorative', () => {
    const branded = renderToStaticMarkup(createElement(ToolIcon, { id: 'claude' }));
    const fallback = renderToStaticMarkup(createElement(ToolIcon, { id: 'toString' }));

    expect(branded).toContain('aria-hidden="true"');
    expect(branded).toContain('focusable="false"');
    expect(fallback).toContain('aria-hidden="true"');
  });
});
