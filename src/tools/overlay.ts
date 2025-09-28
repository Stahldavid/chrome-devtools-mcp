/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Page} from 'puppeteer-core';
import z from 'zod';

import {ToolCategories} from './categories.js';
import {defineTool} from './ToolDefinition.js';

// Schema for target specification
const targetSchema = z.union([
  z.object({
    selector: z.string().describe('CSS selector for the target element'),
  }),
  z.object({
    nodeId: z.number().describe('Chrome DevTools Node ID'),
  }),
  z.object({
    backendNodeId: z.number().describe('Chrome DevTools Backend Node ID'),
  }),
  z.object({
    sid: z.string().regex(/^sid_[A-Za-z0-9_-]{16,}$/).describe('Semantic ID from sem.snapshot'),
  }),
  z.object({
    point: z.object({
      x: z.number().describe('X coordinate'),
      y: z.number().describe('Y coordinate'),
    }).describe('Point coordinates'),
  }),
  z.object({
    rect: z.object({
      x: z.number().describe('X coordinate'),
      y: z.number().describe('Y coordinate'),
      width: z.number().describe('Width'),
      height: z.number().describe('Height'),
    }).describe('Rectangle bounds'),
  }),
]);


interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectFromBox(box: {x: number; y: number; width: number; height: number}): OverlayRect {
  return {
    x: box.x,
    y: box.y,
    width: Math.max(box.width, 1),
    height: Math.max(box.height, 1),
  };
}

async function rectFromCdpNode(
  page: Page,
  identifier: {nodeId?: number; backendNodeId?: number},
): Promise<OverlayRect> {
  const client = await page.createCDPSession();
  try {
    await client.send('DOM.enable');
    const boxModel = await client.send('DOM.getBoxModel', identifier);
    const border = boxModel?.model?.border;
    if (!border || border.length < 8) {
      throw new Error('Element has no box model');
    }
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < border.length; i += 2) {
      xs.push(border[i]);
      ys.push(border[i + 1]);
    }
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return rectFromBox({
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    });
  } finally {
    await client.detach().catch(() => undefined);
  }
}
export const overlayAnnotate = defineTool({
  name: 'overlay_annotate',
  description: 'Draw a highlight (circle/box/underline + label) over a target element or area.',
  annotations: {
    title: 'Annotate Element',
    category: ToolCategories.OVERLAY,
    readOnlyHint: true,
  },
  schema: {
    target: targetSchema.describe('Target to annotate'),
    shape: z.enum(['ring', 'box', 'underline']).default('ring').describe('Shape of the annotation'),
    label: z.string().optional().describe('Optional text label'),
    strokePx: z.number().int().min(1).default(3).describe('Stroke width in pixels'),
    blockInput: z.boolean().default(false).describe('Whether to block user input to the element'),
    ttlMs: z.number().int().min(0).default(0).describe('Time to live in milliseconds'),
    persist: z.boolean().default(true).describe('Whether annotation persists across page changes'),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    const params = request.params;

    let rect: OverlayRect | null = null;
    let attachedTo = 'unknown';

    try {
      if ('selector' in params.target) {
        const element = await page.$(params.target.selector);
        if (!element) {
          throw new Error(`Element not found with selector: ${params.target.selector}`);
        }
        const box = await element.boundingBox();
        await element.dispose();
        if (!box) {
          throw new Error('Element has no bounding box');
        }
        rect = rectFromBox(box);
        attachedTo = 'selector';
      } else if ('nodeId' in params.target) {
        rect = await rectFromCdpNode(page, {nodeId: params.target.nodeId});
        attachedTo = 'nodeId';
      } else if ('backendNodeId' in params.target) {
        rect = await rectFromCdpNode(page, {backendNodeId: params.target.backendNodeId});
        attachedTo = 'backendNodeId';
      } else if ('point' in params.target) {
        rect = rectFromBox({
          x: params.target.point.x - params.strokePx,
          y: params.target.point.y - params.strokePx,
          width: params.strokePx * 2,
          height: params.strokePx * 2,
        });
        attachedTo = 'point';
      } else if ('rect' in params.target) {
        rect = rectFromBox(params.target.rect);
        attachedTo = 'rect';
      } else if ('sid' in params.target) {
        throw new Error('SID-based targeting requires semantic tools to be implemented');
      } else {
        throw new Error('Invalid target specification');
      }

      if (!rect) {
        throw new Error('Unable to compute bounds for annotation target');
      }

      const annotationId = `ovl_${Math.random().toString(36).slice(2, 8)}`;
      const overlayResult = await page.evaluate(
        ({
          annotationId,
          bounds,
          shape,
          label,
          strokePx,
          blockInput,
          ttlMs,
          persist,
        }) => {
          const rootId = '__mcp_overlay_root__';
          let root = document.getElementById(rootId) as HTMLDivElement | null;
          if (!root) {
            root = document.createElement('div');
            root.id = rootId;
            Object.assign(root.style, {
              position: 'fixed',
              inset: '0',
              pointerEvents: 'none',
              zIndex: '2147483647',
            });
            document.documentElement.appendChild(root);
          }

          const viewportWidth = bounds.width;
          const viewportHeight = bounds.height;
          const documentX = bounds.x + window.scrollX;
          const documentYBase = bounds.y + window.scrollY;
          const underlineHeight = Math.max(strokePx, 2);
          const documentY =
            shape === 'underline' ? documentYBase + viewportHeight : documentYBase;
          const overlayHeight = shape === 'underline' ? underlineHeight : viewportHeight;

          const overlay = document.createElement('div');
          overlay.dataset.annotationId = annotationId;
          overlay.style.position = 'fixed';
          overlay.style.width = `${viewportWidth}px`;
          overlay.style.height = `${overlayHeight}px`;
          overlay.style.boxSizing = 'border-box';
          overlay.style.pointerEvents = blockInput ? 'auto' : 'none';
          overlay.style.zIndex = '2147483647';
          const strokeColor = 'rgba(255, 0, 0, 0.9)';
          const fillColor = 'rgba(255, 0, 0, 0.12)';

          if (shape === 'underline') {
            overlay.style.backgroundColor = strokeColor;
          } else {
            overlay.style.border = `${strokePx}px solid ${strokeColor}`;
            overlay.style.backgroundColor = shape === 'box' ? fillColor : 'transparent';
            if (shape === 'ring') {
              overlay.style.borderRadius = '9999px';
            }
          }

          if (label) {
            const labelEl = document.createElement('div');
            labelEl.textContent = label;
            Object.assign(labelEl.style, {
              position: 'absolute',
              bottom: `${overlayHeight + 6}px`,
              left: '0',
              background: strokeColor,
              color: '#fff',
              font: '12px/1.4 sans-serif',
              padding: '2px 6px',
              borderRadius: '4px',
              pointerEvents: 'none',
              transform: 'translateY(-100%)',
            });
            overlay.appendChild(labelEl);
          }

          const updatePosition = () => {
            const offsetLeft = documentX - window.scrollX;
            const offsetTop = documentY - window.scrollY;
            overlay.style.left = `${offsetLeft}px`;
            overlay.style.top = `${offsetTop}px`;
          };
          updatePosition();

          const handleScrollOrResize = () => {
            if (!overlay.isConnected) {
              window.removeEventListener('scroll', handleScrollOrResize);
              window.removeEventListener('resize', handleScrollOrResize);
              return;
            }
            updatePosition();
          };
          window.addEventListener('scroll', handleScrollOrResize, {passive: true});
          window.addEventListener('resize', handleScrollOrResize);

          const cleanup = () => {
            window.removeEventListener('scroll', handleScrollOrResize);
            window.removeEventListener('resize', handleScrollOrResize);
            overlay.remove();
            if (!root || root.childElementCount === 0) {
              root?.remove();
            }
          };
          overlay.addEventListener('mcp-overlay-remove', cleanup);

          if (!persist && ttlMs > 0) {
            window.setTimeout(() => {
              if (overlay.isConnected) {
                cleanup();
              }
            }, ttlMs);
          }

          root.appendChild(overlay);

          return {
            bounds: {
              x: documentX - window.scrollX,
              y: documentY - window.scrollY,
              width: viewportWidth,
              height: overlayHeight,
            },
            documentBounds: {
              x: documentX,
              y: documentY,
              width: viewportWidth,
              height: overlayHeight,
            },
          };
        },
        {
          annotationId,
          bounds: rect,
          shape: params.shape,
          label: params.label ?? null,
          strokePx: params.strokePx,
          blockInput: params.blockInput,
          ttlMs: params.ttlMs,
          persist: params.persist,
        },
      );

      response.appendResponseLine(
        `Created annotation ${annotationId} with ${params.shape} shape targeting ${attachedTo}.`,
      );
      if (params.label) {
        response.appendResponseLine(`Label: "${params.label}"`);
      }

      const result = {
        annotationId,
        attachedTo,
        bounds: overlayResult.bounds,
      };

      response.appendResponseLine(`Annotation details: ${JSON.stringify(result, null, 2)}`);

    } catch (error) {
      throw new Error(`Failed to create annotation: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});

export const overlayClear = defineTool({
  name: 'overlay_clear',
  description: 'Remove an overlay annotation or clear all annotations.',
  annotations: {
    title: 'Clear Overlay',
    category: ToolCategories.OVERLAY,
    readOnlyHint: false,
  },
  schema: {
    annotationId: z.string().optional().describe('ID of specific annotation to remove'),
    all: z.boolean().default(false).describe('Clear all annotations'),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    const params = request.params;

    try {
      const removalResult = await page.evaluate(
        ({annotationId, clearAll}) => {
          const rootId = '__mcp_overlay_root__';
          const root = document.getElementById(rootId) as HTMLDivElement | null;
          if (!root) {
            return {cleared: false};
          }

          const dispatchCleanup = (element: Element | null) => {
            element?.dispatchEvent(new CustomEvent('mcp-overlay-remove'));
          };

          if (clearAll || !annotationId) {
            const overlays = Array.from(root.querySelectorAll('[data-annotation-id]'));
            for (const overlay of overlays) {
              dispatchCleanup(overlay);
            }
            root.remove();
            return {cleared: overlays.length > 0};
          }

          const target = root.querySelector(`[data-annotation-id="${annotationId}"]`);
          if (target) {
            dispatchCleanup(target);
            target.remove();
            if (root.childElementCount === 0) {
              root.remove();
            }
            return {cleared: true};
          }

          return {cleared: false};
        },
        {
          annotationId: params.annotationId ?? null,
          clearAll: params.all,
        },
      );

      const client = await page.createCDPSession();
      await client.send('Overlay.hideHighlight').catch(() => undefined);
      await client.detach().catch(() => undefined);

      if (params.all) {
        response.appendResponseLine('Cleared all overlay annotations');
      } else if (params.annotationId) {
        if (removalResult.cleared) {
          response.appendResponseLine(`Cleared annotation: ${params.annotationId}`);
        } else {
          response.appendResponseLine(`No annotation found with id: ${params.annotationId}`);
        }
      } else if (removalResult.cleared) {
        response.appendResponseLine('Cleared overlay highlight');
      } else {
        response.appendResponseLine('No overlays to clear');
      }

    } catch (error) {
      throw new Error(`Failed to clear overlay: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});

export const overlayPickElement = defineTool({
  name: 'overlay_pick_element',
  description: 'Enable element picker mode for human to select an element. Returns element metadata (ids, bounds, semantics). Requires headed mode.',
  annotations: {
    title: 'Pick Element',
    category: ToolCategories.OVERLAY,
    readOnlyHint: true,
  },
  schema: {
    hint: z.string().default('Click on an element').describe('Hint text for the user'),
    timeoutMs: z.number().int().min(20_000).default(30000).describe('Timeout in milliseconds'),
    highlightOnHover: z.boolean().default(true).describe('Highlight elements on hover'),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    const params = request.params;

    // Check if running in headless mode
    const browser = page.browser();
    const browserVersion = await browser.version();
    if (browserVersion.includes('Headless')) {
      throw new Error('headed_required: overlay_pick_element requires running in headed mode (--headless=false)');
    }

    let client: Awaited<ReturnType<Page['createCDPSession']>> | null = null;
    try {
      client = await page.createCDPSession();
      const session = client;
      if (!session) {
        throw new Error('Unable to create CDP session for element picker');
      }

      const highlightConfig = params.highlightOnHover
        ? {
            borderColor: {r: 0, g: 0, b: 255, a: 0.8},
            contentColor: {r: 0, g: 0, b: 255, a: 0.1},
            showInfo: false,
            showRulers: false,
            showStyles: false,
          }
        : {
            borderColor: {r: 0, g: 0, b: 0, a: 0},
            contentColor: {r: 0, g: 0, b: 0, a: 0},
            showInfo: false,
            showRulers: false,
            showStyles: false,
          };

      // Enable DOM and Overlay domains
      await session.send('DOM.enable');
      await session.send('Overlay.enable');

      response.appendResponseLine(`Element picker activated. ${params.hint}`);
      response.appendResponseLine(`Timeout: ${params.timeoutMs}ms`);

      // Set up element picking mode
      await session.send('Overlay.setInspectMode', {
        mode: 'searchForNode',
        highlightConfig,
      });

      // Wait for human to pick an element
      const picked = await Promise.race([
        new Promise((resolve) => {
          session.on('Overlay.inspectNodeRequested', async (event) => {
            try {
              // Get node details
              const nodeDetails = await session.send('DOM.describeNode', {
                backendNodeId: event.backendNodeId,
              });

              // Get bounding box
              const boxModel = await session.send('DOM.getBoxModel', {
                backendNodeId: event.backendNodeId,
              });

              // Get accessibility info
              let axNode: any = null;
              try {
                const axResponse = await session.send('Accessibility.getAXNodeAndAncestors', {
                  backendNodeId: event.backendNodeId,
                });
                axNode = axResponse.nodes?.[0] || null;
              } catch {
                // Accessibility info might not be available
              }

              const bounds = boxModel.model?.border ? {
                x: Math.min(...boxModel.model.border.filter((_, i) => i % 2 === 0)),
                y: Math.min(...boxModel.model.border.filter((_, i) => i % 2 === 1)),
                width: Math.max(...boxModel.model.border.filter((_, i) => i % 2 === 0)) - 
                       Math.min(...boxModel.model.border.filter((_, i) => i % 2 === 0)),
                height: Math.max(...boxModel.model.border.filter((_, i) => i % 2 === 1)) - 
                        Math.min(...boxModel.model.border.filter((_, i) => i % 2 === 1)),
              } : {x: 0, y: 0, width: 0, height: 0};

              resolve({
                picked: {
                  nodeId: nodeDetails.node.nodeId,
                  backendNodeId: event.backendNodeId,
                  cssPath: (nodeDetails.node as any).cssPath || '',
                  bounds,
                  ax: axNode ? {
                    role: (axNode.role as any)?.value || '',
                    name: (axNode.name as any)?.value || '',
                  } : {role: '', name: ''},
                  sid: `sid_${Math.random().toString(36).substring(2, 18)}`, // Placeholder SID
                  html: (nodeDetails.node as any).outerHTML || '',
                },
              });
            } catch (error) {
              resolve({
                error: `Failed to get element details: ${error instanceof Error ? error.message : String(error)}`,
              });
            }
          });
        }),
        new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Element picking timed out after ${params.timeoutMs}ms`));
          }, params.timeoutMs);
        }),
      ]);

      // Disable inspect mode
      await session.send('Overlay.setInspectMode', {mode: 'none', highlightConfig});
      await session.send('Overlay.disable');

      response.appendResponseLine(`Element picked: ${JSON.stringify(picked, null, 2)}`);

    } catch (error) {
      if (error instanceof Error && error.message.includes('timed out')) {
        response.appendResponseLine(error.message);
        response.appendResponseLine(
          'No element was selected. overlay_pick_element requires a human click in a headed browser session.',
        );
        return;
      }
      throw new Error(`Failed to pick element: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await client?.detach().catch(() => undefined);
    }
  },
});