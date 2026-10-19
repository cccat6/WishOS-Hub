import { PreflightError } from './preflight.js';
const object = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const builtInStyles =
  'bgColor,bgOpacity,textColor,textAlign,fontSize,font,padding,paddingLeft,paddingRight,paddingTop,paddingBottom,radius,borderWidth,borderColor,imageOpacity';
/** Structure for the selected Brookesia subset. Font aliases are runtime state;
 * their registration and actual glyph/image readiness belong to native prepare. */
export async function preflightUi(
  file: string,
  doc: any,
  options: {
    capabilities: any;
    targetBound?: boolean;
    reference: (file: string, path: string) => Promise<string>;
    document: (file: string) => Promise<any>;
    fileBytes: (file: string) => number | undefined;
    fontCoverage?: (
      font: string,
      size: number | undefined,
      codepoints: number[],
    ) => Promise<number[]>;
  },
) {
  // Offline admission checks the known document grammar, not an imagined legacy
  // adapter. Target admission still uses only the target's advertised extensions.
  const caps =
    options.targetBound === false
      ? {
          nodes: 'viewScreen,container,label,button,image,qrcode',
          styles: builtInStyles + ',lineHeight',
          label_metrics: 'line,ink',
          label_overflow: 'wrap,clip,ellipsis',
          label_vertical_align: 'start,center,end',
          label_font_fit: 'minFontSize',
          image_fit: 'none,contain,cover',
          flex_alignment: 'start,center,end',
          ...options.capabilities,
        }
      : options.capabilities;
  const choice = (
    value: unknown,
    capability: string,
    fallback: string,
    code: string,
    context: string,
  ) => {
    if (
      value !== undefined &&
      (typeof value !== 'string' ||
        !String(caps[capability] ?? fallback)
          .split(',')
          .includes(value))
    )
      throw new PreflightError(code, { file: context });
  };
  if (caps.format && caps.format !== 'brookesia-json-ui-0.1.x-subset')
    throw new PreflightError('ui_target_format', { file, detail: caps.format });
  if (
    !['0.1.0', '0.1.1'].includes(doc.version) ||
    !Array.isArray(doc.assets) ||
    doc.assets.length !== 1 ||
    (doc.variants && Object.keys(doc.variants).length)
  )
    throw new PreflightError('ui_format', { file });
  const supported = String(caps.nodes ?? 'viewScreen,container,label,button,image').split(','),
    styles = String(caps.styles ?? builtInStyles).split(','),
    ids = new Set<string>();
  let count = 0;
  const coverage = new Map<
    string,
    {
      file: string;
      font: string;
      size: number | undefined;
      points: Set<number>;
      strict: Set<number>;
    }
  >();
  const warnings: { code: string; file: string; detail: string }[] = [];
  const bound = (path: string) => {
    const size = options.fileBytes(path);
    if (
      typeof size === 'number' &&
      typeof caps.max_document_bytes === 'number' &&
      size > caps.max_document_bytes
    )
      throw new PreflightError('ui_document_limit', { file: path });
  };
  type Typography = { font?: string; fontSize?: unknown };
  const walk = async (
    node: any,
    context: string,
    depth: number,
    inherited: Typography,
  ): Promise<void> => {
    if (!object(node) || typeof node.type !== 'string' || !supported.includes(node.type))
      throw new PreflightError('ui_node', { file: context });
    if (++count > caps.max_nodes || depth > caps.max_depth)
      throw new PreflightError('ui_node_limit', { file: context });
    if (node.id !== undefined) {
      if (typeof node.id !== 'string' || ids.has(node.id))
        throw new PreflightError('ui_node_id', { file: context });
      ids.add(node.id);
    }
    for (const key of ['style', 'placement', 'layout', 'labelProps', 'imageProps', 'qrcodeProps'])
      if (node[key] !== undefined && !object(node[key]))
        throw new PreflightError('ui_node_object', { file: context, detail: key });
    if (
      (node.events && Object.keys(node.events).length) ||
      (node.bindings && Object.keys(node.bindings).length)
    )
      throw new PreflightError('ui_use_application_bindings', { file: context });
    const style = node.style ?? {};
    for (const key of Object.keys(style))
      if (!styles.includes(key))
        throw new PreflightError('ui_style_not_supported', { file: context, detail: key });
    for (const key of ['font', 'textAlign', 'bgColor', 'textColor', 'borderColor'])
      if (style[key] !== undefined && typeof style[key] !== 'string')
        throw new PreflightError('ui_style_type', { file: context, detail: key });
    if (style.textAlign !== undefined && !['left', 'center', 'right'].includes(style.textAlign))
      throw new PreflightError('ui_text_alignment', { file: context });
    if (style.lineHeight !== undefined) {
      const raw = style.lineHeight;
      const height =
        typeof raw === 'number'
          ? raw
          : typeof raw === 'string' && /^[-+]?\d+(dp|sp)?$/.test(raw)
            ? parseInt(raw, 10)
            : NaN;
      if (!Number.isInteger(height) || height < 8 || height > 192)
        throw new PreflightError('ui_line_height', { file: context });
    }
    for (const key of ['bgOpacity', 'imageOpacity'])
      if (
        style[key] !== undefined &&
        typeof style[key] === 'number' &&
        (!Number.isInteger(style[key]) || style[key] < 0 || style[key] > 255)
      )
        throw new PreflightError('ui_opacity', { file: context });
    const typography = {
      font: style.font ?? inherited.font,
      fontSize: style.fontSize ?? inherited.fontSize,
    };
    if (
      typography.font === 'system' &&
      typography.fontSize !== undefined &&
      Array.isArray(caps.fonts)
    ) {
      const fonts = caps.fonts.filter((f: any) => f.id === 'system'),
        raw = typography.fontSize,
        size =
          typeof raw === 'number'
            ? raw
            : typeof raw === 'string' && /^[-+]?\d+(dp|sp)?$/.test(raw)
              ? parseInt(raw, 10)
              : NaN;
      if (
        fonts.length &&
        !fonts.some(
          (f: any) =>
            f.size === size ||
            (f.scalable === true &&
              Number.isInteger(size) &&
              size >= (f.minimum_size ?? caps.scalable_font_sizes?.minimum) &&
              size <= (f.maximum_size ?? caps.scalable_font_sizes?.maximum)),
        )
      )
        throw new PreflightError('ui_system_font_size', { file: context });
    }
    const layout = node.layout ?? {};
    if (
      (layout.type !== undefined && !['none', 'flex'].includes(layout.type)) ||
      (layout.type === 'flex' &&
        layout.flexFlow !== undefined &&
        !['row', 'column'].includes(layout.flexFlow))
    )
      throw new PreflightError('ui_layout_not_supported', { file: context });
    for (const key of ['mainAlign', 'crossAlign'])
      choice(layout[key], 'flex_alignment', 'start', 'ui_flex_alignment', context);
    if (
      node.labelProps &&
      Object.keys(node.labelProps).some(
        (key) =>
          !['text', 'missingGlyph', 'longMode', 'metrics', 'verticalAlign', 'minFontSize'].includes(
            key,
          ),
      )
    )
      throw new PreflightError('ui_label_property', { file: context });
    if (node.labelProps?.text !== undefined && typeof node.labelProps.text !== 'string')
      throw new PreflightError('ui_label_text', { file: context });
    if (
      options.fontCoverage &&
      node.type === 'label' &&
      typeof node.labelProps?.text === 'string'
    ) {
      const rawFont = typography.font ?? 'system';
      const font = /^\$\{font\.([^}]+)\}$/.exec(rawFont)?.[1] ?? rawFont;
      if (
        font === 'system' ||
        font === 'builtin' ||
        font.startsWith('/') ||
        caps.fonts?.some((f: any) => f.id === font && !f.owner && !f.retiring)
      ) {
        const raw = typography.fontSize;
        const size =
          raw === undefined
            ? undefined
            : typeof raw === 'number'
              ? raw
              : typeof raw === 'string' && /^[-+]?\d+(dp|sp)?$/.test(raw)
                ? parseInt(raw, 10)
                : NaN;
        if (size !== undefined && !Number.isInteger(size))
          throw new PreflightError('ui_style_type', { file: context, detail: 'fontSize' });
        const key = JSON.stringify([context, font, size ?? null]);
        const use = coverage.get(key) ?? {
          file: context,
          font,
          size,
          points: new Set<number>(),
          strict: new Set<number>(),
        };
        for (const char of node.labelProps.text) {
          const cp = char.codePointAt(0)!;
          if (cp === 10 || cp === 13) continue;
          use.points.add(cp);
          if (node.labelProps.missingGlyph !== 'replace') use.strict.add(cp);
        }
        coverage.set(key, use);
      } else warnings.push({ code: 'ui_font_coverage_deferred', file: context, detail: font });
    }
    if (
      node.labelProps?.missingGlyph !== undefined &&
      !['error', 'replace'].includes(node.labelProps.missingGlyph)
    )
      throw new PreflightError('ui_missing_glyph_policy', { file: context });
    choice(node.labelProps?.metrics, 'label_metrics', 'line', 'ui_label_metrics', context);
    choice(node.labelProps?.longMode, 'label_overflow', 'wrap', 'ui_label_long_mode', context);
    if (node.labelProps?.verticalAlign !== undefined) {
      if (!['start', 'center', 'end'].includes(node.labelProps.verticalAlign))
        throw new PreflightError('ui_label_vertical_align', { file: context });
      choice(
        node.labelProps.verticalAlign,
        'label_vertical_align',
        '',
        'ui_label_vertical_align',
        context,
      );
      if (
        node.type !== 'label' ||
        node.labelProps.metrics !== 'ink' ||
        !Number.isInteger(node.placement?.height) ||
        node.placement.height <= 0
      )
        throw new PreflightError('ui_label_vertical_align_geometry', { file: context });
    }

    if (node.labelProps?.minFontSize !== undefined) {
      choice('minFontSize', 'label_font_fit', '', 'ui_label_font_fit', context);
      const min = node.labelProps.minFontSize;
      if (
        node.type !== 'label' ||
        node.labelProps.metrics !== 'ink' ||
        !Number.isInteger(node.placement?.width) ||
        node.placement.width <= 0 ||
        !Number.isInteger(min) ||
        min < 8 ||
        min > 96
      )
        throw new PreflightError('ui_label_font_fit_geometry', { file: context });
      if (typography.fontSize !== undefined) {
        const raw = typography.fontSize;
        const max =
          typeof raw === 'number'
            ? raw
            : typeof raw === 'string' && /^[-+]?\d+(dp|sp)?$/.test(raw)
              ? parseInt(raw, 10)
              : NaN;
        if (!Number.isInteger(max) || min > max)
          throw new PreflightError('ui_label_font_fit_range', { file: context });
      }
    }
    choice(node.imageProps?.fit, 'image_fit', 'none', 'ui_image_fit', context);
    if (
      node.qrcodeProps !== undefined &&
      Object.entries(node.qrcodeProps).some(
        ([key, value]) => key !== 'text' || typeof value !== 'string',
      )
    )
      throw new PreflightError('ui_qrcode_property', { file: context });
    if (node.type === 'image') {
      if (typeof node.imageProps?.src !== 'string' || !node.imageProps.src)
        throw new PreflightError('ui_image_source', { file: context });
      await options.reference(context, node.imageProps.src);
    }
    if (node.children !== undefined) {
      if (!Array.isArray(node.children)) throw new PreflightError('ui_children', { file: context });
      for (const child of node.children) await walk(child, context, depth + 1, typography);
    }
  };
  bound(file);
  for (const asset of doc.assets) {
    let node = asset,
      context = file;
    if (typeof asset === 'string') {
      context = await options.reference(file, asset);
      node = await options.document(context);
      bound(context);
    }
    if (!object(node) || node.type !== 'viewScreen')
      throw new PreflightError('ui_screen_missing', { file: context });
    await walk(node, context, 0, { font: 'system' });
  }
  for (const use of coverage.values()) {
    const points = [...use.points].sort((a, b) => a - b);
    if (!points.length) continue;
    const missing = await options.fontCoverage!(use.font, use.size, points);
    if (!Array.isArray(missing) || missing.some((cp) => !use.points.has(cp)))
      throw new PreflightError('ui_font_coverage_reply', { file: use.file });
    const codes = [...new Set(missing)]
      .map((cp) => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0'))
      .join(',');
    if (missing.some((cp) => use.strict.has(cp)))
      throw new PreflightError('ui_font_missing_glyph', {
        file: use.file,
        detail: `${use.font}${use.size === undefined ? '' : ':' + use.size} ${codes}`,
      });
    if (missing.length)
      warnings.push({ code: 'ui_font_glyph_replacement', file: use.file, detail: codes });
  }
  return { schema_valid: true, render_ready: false, warnings };
}
