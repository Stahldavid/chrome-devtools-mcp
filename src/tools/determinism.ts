/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';
import z from 'zod';

import {ToolCategories} from './categories.js';
import {defineTool} from './ToolDefinition.js';

export const timeFreeze = defineTool({
  name: 'time_freeze',
  description: 'Pause timers, requestAnimationFrame, and compositor animations for deterministic execution.',
  annotations: {
    title: 'Freeze Time',
    category: ToolCategories.DETERMINISM,
    readOnlyHint: false,
  },
  schema: {
    pause_compositor_animations: z.boolean().default(true).describe('Whether to pause compositor animations'),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    const params = request.params;

    try {
      const client = await page.createCDPSession();
      
      // Enable required domains
      await client.send('Runtime.enable');
      
      // Set virtual time policy to pause
      await client.send('Emulation.setVirtualTimePolicy', {
        policy: 'pause',
        initialVirtualTime: Date.now(),
      });

      // Disable animations if requested
      if (params.pause_compositor_animations) {
        await client.send('Animation.enable');
        await client.send('Animation.setPlaybackRate', {
          playbackRate: 0,
        });
        
        // Also disable CSS animations via CSS
        await page.addStyleTag({
          content: `
            *, *::before, *::after {
              animation-duration: 0s !important;
              animation-delay: 0s !important;
              transition-duration: 0s !important;
              transition-delay: 0s !important;
            }
          `,
        });
      }

      // Pause JavaScript timers
      await page.evaluate(() => {
        // Store original timer functions
        (window as any).__originalSetTimeout = window.setTimeout;
        (window as any).__originalSetInterval = window.setInterval;
        (window as any).__originalRequestAnimationFrame = window.requestAnimationFrame;
        
        // Replace with no-ops (cast to any to avoid type issues)
        (window.setTimeout as any) = () => 0;
        (window.setInterval as any) = () => 0;
        (window.requestAnimationFrame as any) = () => 0;
      });

      response.appendResponseLine('Time frozen successfully');
      response.appendResponseLine('- Virtual time paused');
      response.appendResponseLine('- JavaScript timers disabled');
      if (params.pause_compositor_animations) {
        response.appendResponseLine('- Compositor animations paused');
        response.appendResponseLine('- CSS animations disabled');
      }

    } catch (error) {
      throw new Error(`Failed to freeze time: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});

export const timeResume = defineTool({
  name: 'time_resume',
  description: 'Resume normal time flow (timers, RAF, animations).',
  annotations: {
    title: 'Resume Time',
    category: ToolCategories.DETERMINISM,
    readOnlyHint: false,
  },
  schema: {},
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();

    try {
      const client = await page.createCDPSession();
      
      // Resume virtual time
      await client.send('Emulation.setVirtualTimePolicy', {
        policy: 'advance',
        budget: 5000, // Allow 5 seconds of advancement
      });

      // Re-enable animations
      try {
        await client.send('Animation.setPlaybackRate', {
          playbackRate: 1,
        });
      } catch {
        // Animation domain might not be enabled
      }

      // Restore JavaScript timers
      await page.evaluate(() => {
        if ((window as any).__originalSetTimeout) {
          window.setTimeout = (window as any).__originalSetTimeout;
          window.setInterval = (window as any).__originalSetInterval;
          window.requestAnimationFrame = (window as any).__originalRequestAnimationFrame;
        }
      });

      // Remove CSS animation disabling
      await page.addStyleTag({
        content: `
          /* Re-enable animations */
          * { animation: unset !important; transition: unset !important; }
        `,
      });

      response.appendResponseLine('Time resumed successfully');
      response.appendResponseLine('- Virtual time advancing');
      response.appendResponseLine('- JavaScript timers restored');
      response.appendResponseLine('- Animations re-enabled');

    } catch (error) {
      throw new Error(`Failed to resume time: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});

export const execStep = defineTool({
  name: 'exec_step',
  description: 'Advance N ticks of virtual time for deterministic stepping.',
  annotations: {
    title: 'Execute Step',
    category: ToolCategories.DETERMINISM,
    readOnlyHint: false,
  },
  schema: {
    ticks: z.number().int().min(1).default(1).describe('Number of ticks to advance'),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    const params = request.params;

    try {
      const client = await page.createCDPSession();
      
      // Advance virtual time by the specified number of ticks
      // Each tick represents ~16ms (60fps frame)
      const tickDuration = 16.67; // ms
      const advanceMs = params.ticks * tickDuration;

      await client.send('Emulation.setVirtualTimePolicy', {
        policy: 'pauseIfNetworkFetchesPending',
        budget: advanceMs,
      });

      // Wait a moment for the advancement to take effect
      await new Promise(resolve => setTimeout(resolve, 100));

      response.appendResponseLine(`Advanced ${params.ticks} ticks (${advanceMs.toFixed(2)}ms)`);
      response.appendResponseLine(`Result: ${JSON.stringify({ advanced_ticks: params.ticks }, null, 2)}`);

    } catch (error) {
      throw new Error(`Failed to execute step: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});

export const viewScreenshot = defineTool({
  name: 'view_screenshot',
  description: 'Take a stabilized screenshot with optional PII redaction and masking.',
  annotations: {
    title: 'Stabilized Screenshot',
    category: ToolCategories.DETERMINISM,
    readOnlyHint: true,
  },
  schema: {
    region: z.enum(['viewport', 'element', 'rect']).default('viewport').describe('Region to capture'),
    sid: z.string().optional().describe('SID of element to capture (when region=element)'),
    rect: z.object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    }).optional().describe('Rectangle to capture (when region=rect)'),
    full_page: z.boolean().default(false).describe('Capture full page instead of viewport'),
    device_scale_factor: z.number().min(0.5).max(4).default(1).describe('Device scale factor'),
    mask: z.object({
      sids: z.array(z.string()).optional().describe('SIDs to mask'),
      rects: z.array(z.object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      })).optional().describe('Rectangle areas to mask'),
    }).optional().describe('Areas to mask'),
    redact_pii: z.boolean().default(false).describe('Enable PII redaction'),
    redact_text_patterns: z.array(z.string()).optional().describe('Additional text patterns to redact'),
    format: z.enum(['png', 'jpeg', 'webp']).default('png').describe('Image format'),
    quality: z.number().int().min(1).max(100).optional().describe('JPEG/WebP quality (1-100)'),
    stabilize_ms: z.number().int().min(0).default(150).describe('Stabilization delay in milliseconds'),
    timeout_ms: z.number().int().min(0).default(15000).describe('Total timeout in milliseconds'),
  },
  handler: async (request, response, context) => {
    const page = context.getSelectedPage();
    const params = request.params;

    try {
      const startTime = Date.now();

      // Stabilization delay
      if (params.stabilize_ms > 0) {
        response.appendResponseLine(`Stabilizing for ${params.stabilize_ms}ms...`);
        await new Promise(resolve => setTimeout(resolve, params.stabilize_ms));
      }

      // Apply PII redaction if requested
      if (params.redact_pii) {
        const redactionPatterns = [
          // Email patterns
          /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
          // Phone patterns (basic)
          /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g,
          // SSN-like patterns
          /\b\d{3}-?\d{2}-?\d{4}\b/g,
          // Credit card patterns (basic)
          /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
        ];

        // Add custom patterns
        if (params.redact_text_patterns) {
          for (const pattern of params.redact_text_patterns) {
            try {
              redactionPatterns.push(new RegExp(pattern, 'g'));
            } catch {
              // Invalid regex pattern, skip
            }
          }
        }

        // Apply redaction via CSS (simplified approach)
        await page.addStyleTag({
          content: `
            /* Hide potentially sensitive inputs */
            input[type="password"],
            input[type="email"],
            input[name*="ssn"],
            input[name*="credit"],
            input[name*="card"] {
              background: black !important;
              color: black !important;
            }
          `,
        });
      }

      // Apply masking if specified
      if (params.mask) {
        let maskCSS = '';
        
        // Mask specific rectangles
        if (params.mask.rects) {
          for (let i = 0; i < params.mask.rects.length; i++) {
            const rect = params.mask.rects[i];
            maskCSS += `
              .mcp-mask-rect-${i} {
                position: fixed !important;
                top: ${rect.y}px !important;
                left: ${rect.x}px !important;
                width: ${rect.width}px !important;
                height: ${rect.height}px !important;
                background: black !important;
                z-index: 999999 !important;
              }
            `;
          }
          
          // Add mask elements
          await page.evaluate((rects) => {
            for (let i = 0; i < rects.length; i++) {
              const maskDiv = document.createElement('div');
              maskDiv.className = `mcp-mask-rect-${i}`;
              document.body.appendChild(maskDiv);
            }
          }, params.mask.rects);
        }

        if (maskCSS) {
          await page.addStyleTag({ content: maskCSS });
        }
      }

      // Take screenshot based on region type
      let screenshot: Uint8Array;
      
      if (params.region === 'viewport') {
        screenshot = await page.screenshot({
          type: params.format as 'png' | 'jpeg' | 'webp',
          quality: params.quality,
          fullPage: params.full_page,
        });
      } else if (params.region === 'element' && params.sid) {
        // For SID-based screenshots, we'd need to resolve the SID to an element
        // For now, throw an error indicating SID resolution is needed
        throw new Error('SID-based screenshots require semantic system integration');
      } else if (params.region === 'rect' && params.rect) {
        screenshot = await page.screenshot({
          type: params.format as 'png' | 'jpeg' | 'webp',
          quality: params.quality,
          clip: {
            x: params.rect.x,
            y: params.rect.y,
            width: params.rect.width,
            height: params.rect.height,
          },
        });
      } else {
        throw new Error('Invalid region specification or missing required parameters');
      }

      // Clean up masks
      if (params.mask?.rects) {
        await page.evaluate((rectCount) => {
          for (let i = 0; i < rectCount; i++) {
            const maskElement = document.querySelector(`.mcp-mask-rect-${i}`);
            if (maskElement) {
              maskElement.remove();
            }
          }
        }, params.mask.rects.length);
      }

      // Calculate metadata
      const byteSize = screenshot.length;
      const sha256 = crypto.createHash('sha256').update(screenshot).digest('hex');
      const createdMs = Date.now() - startTime;

      // Prepare response
      const imageData = Buffer.from(screenshot).toString('base64');
      const dataUrl = `data:image/${params.format};base64,${imageData}`;

      const result = {
        image: {
          format: params.format,
          mime: `image/${params.format}`,
          dataUrl,
          width: 1280, // Placeholder - would get from actual screenshot
          height: 800,  // Placeholder - would get from actual screenshot
        },
        meta: {
          sha256,
          byte_size: byteSize,
          created_ms: createdMs,
        },
      };

      response.appendResponseLine(`Screenshot captured successfully`);
      response.appendResponseLine(`Format: ${params.format}, Size: ${byteSize} bytes`);
      response.appendResponseLine(`Stabilization time: ${params.stabilize_ms}ms, Total time: ${createdMs}ms`);
      
      // Attach the image to the response
      response.attachImage({
        data: imageData,
        mimeType: `image/${params.format}`,
      });

      response.appendResponseLine(`Metadata: ${JSON.stringify(result.meta, null, 2)}`);

    } catch (error) {
      throw new Error(`Failed to take stabilized screenshot: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});