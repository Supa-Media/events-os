/**
 * ONE BLOCK, DRAWN AS THE EMAIL DRAWS IT.
 *
 * This is the canvas half of the WYSIWYG bargain: every block renders as the
 * thing it will be — a hero card is a maroon card with a 38px centred headline,
 * not a form with a "Style" dropdown — and the text inside it edits where it
 * sits.
 *
 * Three rules this file follows without exception:
 *
 *  1. NO NUMBERS. Every size, padding and colour comes from `canvasStyles.ts`,
 *     which reads `@events-os/shared`'s `EMAIL_GEOMETRY`/`EMAIL_CARD_SPECS` —
 *     the same table `emailRender.ts` paints the real email from. If a value
 *     is missing, add it there, not here.
 *  2. NO PER-BLOCK COLOUR. Fills and text colours are resolved from the
 *     document's THEME through the variant's spec role (`emailTheme.ts`:
 *     "Blocks inherit; no block carries its own colour"). There is no colour
 *     control on this canvas by design.
 *  3. UNIVERSAL PRIMITIVES ONLY. `View`/`Text`/`Image`/`TextInput`/`Pressable`
 *     — no raw DOM elements, which typecheck fine and crash React Native at
 *     runtime. The composer runs on phones today.
 */
import { Platform, Text, View } from "react-native";
import type { EmailBlock, EmailCardContent, EmailTheme } from "@events-os/shared";
import { CanvasEditableText, CanvasImage, CanvasMarkdown } from "./CanvasText";
import {
  BLEED_PLACEHOLDER_LABEL_SIZE,
  BUTTON_MARGIN_BOTTOM,
  CARD_BODY_MARGIN_BOTTOM,
  CARD_CTA_MARGIN_TOP,
  CARD_IMAGE_MARGIN_BOTTOM,
  CARD_PLACEHOLDER_LABEL_SIZE,
  COLUMNS_GUTTER,
  COLUMNS_MARGIN_BOTTOM,
  EYEBROW_MARGIN_BOTTOM,
  FOOTER_LOGO,
  POLL_MARGIN_BOTTOM,
  QUOTE_ATTRIBUTION_PREFIX,
  bleedPlaceholderStyle,
  bodyTextStyle,
  buttonAlign,
  buttonBoxStyle,
  buttonLabelStyle,
  cardAlign,
  cardAttributionStyle,
  cardBodyStyle,
  cardBoxStyle,
  cardColumnSplit,
  cardEyebrowStyle,
  cardHeadingStyle,
  cardImageRadius,
  cardPlaceholderStyle,
  cardSpecFor,
  cardTextColorFor,
  dividerStyle,
  eyebrowStyle,
  footerBoxStyle,
  footerLegalStyle,
  footerLinksStyle,
  footerNavStyle,
  hairlineStyle,
  headingStyle,
  imageStyle,
  linkTextStyle,
  placeholderLabelStyle,
  pollOptionBoxStyle,
  pollOptionLabelStyle,
  pollQuestionStyle,
  quoteAttributionStyle,
  quoteBoxStyle,
  quoteTextStyle,
  spacerHeight,
} from "./canvasStyles";

const IS_WEB = Platform.OS === "web";

export type BlockViewProps = {
  block: EmailBlock;
  theme: EmailTheme;
  /** False on a locked document: everything still renders, nothing edits. */
  editable: boolean;
  /**
   * Whether this block is the selected one.
   *
   * Drives the OPTIONAL parts — a card's eyebrow and call to action, a quote's
   * attribution, the footer's nav line. An unselected block draws only what the
   * email will actually contain (fidelity); selecting it reveals the empty
   * slots as faint placeholders you can click and fill (affordance). Showing
   * them always would put lines on the canvas that are not in the email; never
   * showing them would leave no way to add one without a form.
   */
  selected: boolean;
  /** Which of THIS block's fields is being edited in place, if any. */
  editingField: string | null;
  onStartEditing: (field: string) => void;
  onStopEditing: () => void;
  onChange: (patch: Record<string, unknown>) => void;
};

export function BlockView(props: BlockViewProps) {
  const { block, theme: t } = props;

  switch (block.kind) {
    case "heading":
      return (
        <EditableField
          {...props}
          field="text"
          value={block.text}
          placeholder="Heading"
          label="heading"
          style={headingStyle(t, block.level === 2 ? 2 : 1, IS_WEB)}
          onChangeText={(text) => props.onChange({ text })}
        />
      );

    case "text": {
      const style = bodyTextStyle(t, IS_WEB);
      return (
        <EditableField
          {...props}
          field="markdown"
          value={block.markdown}
          placeholder="Write your message… **bold**, *italic*, [links](https://…), - lists"
          label="body text"
          style={style}
          multiline
          onChangeText={(markdown) => props.onChange({ markdown })}
          // Read: formatted. Editing: the literal markdown, because that is
          // what she is actually editing and hiding it would make `**` appear
          // from nowhere on the next click.
          renderStatic={() => (
            <CanvasMarkdown markdown={block.markdown} style={style} linkStyle={linkTextStyle(t)} />
          )}
        />
      );
    }

    case "eyebrow":
      return (
        <View style={{ marginBottom: EYEBROW_MARGIN_BOTTOM, flexDirection: "row" }}>
          {block.icon ? (
            <Text style={eyebrowStyle(t, IS_WEB)}>{`${block.icon}  `}</Text>
          ) : null}
          <EditableField
            {...props}
            field="text"
            value={block.text}
            placeholder="THIS MONTH"
            label="eyebrow"
            style={eyebrowStyle(t, IS_WEB)}
            onChangeText={(text) => props.onChange({ text })}
          />
        </View>
      );

    case "image":
      return (
        <View style={imageStyle(t, block.width)}>
          {block.url ? (
            <CanvasImage
              url={block.url}
              accessibilityLabel={block.alt || "Image"}
              style={{ borderRadius: t.radius }}
            />
          ) : (
            <Placeholder
              theme={t}
              label="Choose an image"
              size={CARD_PLACEHOLDER_LABEL_SIZE}
              variant="card"
            />
          )}
        </View>
      );

    case "bleed_image":
      return block.url ? (
        <CanvasImage url={block.url} accessibilityLabel={block.alt || "Banner"} />
      ) : (
        <Placeholder
          theme={t}
          label={block.alt || "Add artwork from the image library"}
          size={BLEED_PLACEHOLDER_LABEL_SIZE}
          variant="bleed"
        />
      );

    case "button": {
      const variant = block.variant ?? "filled";
      return (
        <View
          style={{
            marginBottom: BUTTON_MARGIN_BOTTOM,
            // A button with no `align` of its own SENDS centred
            // (`renderButtonBlock`), and `defaultBlockFor` sets none — so
            // every freshly added button hit this. The default is read from
            // the geometry table, not restated here.
            alignItems: buttonAlign(block.align) === "center" ? "center" : "flex-start",
          }}
        >
          <View style={buttonBoxStyle(t, variant, null)}>
            <EditableField
              {...props}
              field="label"
              value={block.label}
              placeholder="Click here"
              label="button label"
              style={buttonLabelStyle(t, variant, IS_WEB)}
              onChangeText={(label) => props.onChange({ label })}
            />
          </View>
        </View>
      );
    }

    case "divider":
      return <View style={dividerStyle(t)} />;

    case "hairline":
      return <View style={hairlineStyle(t)} />;

    case "spacer":
      return <View style={{ height: spacerHeight(block.size) }} />;

    case "quote":
      return (
        <View style={quoteBoxStyle(t)}>
          <EditableField
            {...props}
            field="text"
            value={block.text}
            placeholder="The line worth pulling out"
            label="quote"
            multiline
            style={quoteTextStyle(t, IS_WEB)}
            onChangeText={(text) => props.onChange({ text })}
          />
          {block.attribution !== undefined || (props.editable && props.selected) ? (
            <EditableField
              {...props}
              field="attribution"
              value={block.attribution ?? ""}
              // The em dash is the RENDERER's (`renderQuoteBlock` emits
              // `— ${attribution}`), so the canvas draws it and the field
              // edits the bare name. A placeholder carrying the dash invited
              // typing a second one, and the email shipped "— — Ada".
              staticPrefix={QUOTE_ATTRIBUTION_PREFIX}
              placeholder="Who said it"
              label="attribution"
              style={quoteAttributionStyle(t, IS_WEB)}
              onChangeText={(attribution) => props.onChange({ attribution })}
            />
          ) : null}
        </View>
      );

    case "poll":
      return (
        <View style={{ marginBottom: POLL_MARGIN_BOTTOM }}>
          <EditableField
            {...props}
            field="question"
            value={block.question}
            placeholder="What should we do next?"
            label="poll question"
            style={pollQuestionStyle(t, IS_WEB)}
            onChangeText={(question) => props.onChange({ question })}
          />
          {block.options.map((option, index) => (
            <View key={option.id} style={pollOptionBoxStyle(t)}>
              <EditableField
                {...props}
                field={`option-${index}`}
                value={option.label}
                placeholder={`Option ${index + 1}`}
                label={`option ${index + 1}`}
                style={pollOptionLabelStyle(t, IS_WEB)}
                onChangeText={(label) =>
                  props.onChange({
                    // Patch the LABEL only — a vote is recorded against
                    // `option.id`, so regenerating one on a rename would
                    // orphan every vote already cast for it.
                    options: block.options.map((o, i) =>
                      i === index ? { ...o, label } : o,
                    ),
                  })
                }
              />
            </View>
          ))}
        </View>
      );

    case "card":
      return (
        <View style={cardBoxStyle(t, cardSpecFor(block.variant))}>
          <CardView
            {...props}
            content={block}
            fieldPrefix=""
            onChangeContent={(patch) => props.onChange(patch)}
          />
        </View>
      );

    case "columns":
      return (
        <View style={{ flexDirection: "row", marginBottom: COLUMNS_MARGIN_BOTTOM }}>
          {block.columns.map((column, index) => {
            const last = index === block.columns.length - 1;
            return (
              <View
                key={index}
                style={{ flex: 1, marginRight: last ? 0 : COLUMNS_GUTTER }}
              >
                <View style={cardBoxStyle(t, cardSpecFor(column.variant), { bare: true })}>
                  <CardView
                    {...props}
                    content={column}
                    fieldPrefix={`col-${index}-`}
                    onChangeContent={(patch) =>
                      props.onChange({
                        columns: block.columns.map((c, i) =>
                          i === index ? { ...c, ...patch } : c,
                        ),
                      })
                    }
                  />
                </View>
              </View>
            );
          })}
        </View>
      );

    case "footer":
      return (
        <View style={footerBoxStyle(t)}>
          {block.logoUrl ? (
            <View style={{ alignItems: "center", marginBottom: FOOTER_LOGO.marginBottom }}>
              <View style={{ width: "100%", maxWidth: FOOTER_LOGO.maxWidth }}>
                <CanvasImage url={block.logoUrl} accessibilityLabel={block.logoAlt || "Logo"} />
              </View>
            </View>
          ) : null}
          {block.navLine !== undefined || (props.editable && props.selected) ? (
            <EditableField
              {...props}
              field="navLine"
              value={block.navLine ?? ""}
              placeholder="Sundays · 10am · The Old Fire Station"
              label="nav line"
              style={footerNavStyle(t, IS_WEB)}
              onChangeText={(navLine) => props.onChange({ navLine: navLine || undefined })}
            />
          ) : null}
          {block.links?.length ? (
            <Text style={footerLinksStyle(t, IS_WEB)}>
              {block.links.map((l) => l.label || "—").join("  |  ")}
            </Text>
          ) : null}
          {/* The unsubscribe line is renderer furniture — `emailRender.ts`
              appends it to every send from the send's own token, because a
              send that can lose its opt-out to an editing mistake is a legal
              problem. Shown here so the footer's real height is honest; not
              editable, because it isn't. */}
          <Text style={footerLegalStyle(t, IS_WEB)}>
            Unsubscribe from all Public Worship emails.
          </Text>
        </View>
      );

    default:
      return null;
  }
}

/**
 * A card's interior — the shape `card` and each cell of `columns` share,
 * exactly as `EmailCardContent` intends and `renderCardInner` renders.
 */
function CardView({
  content,
  theme: t,
  fieldPrefix,
  onChangeContent,
  editable,
  selected,
  editingField,
  onStartEditing,
  onStopEditing,
}: Omit<BlockViewProps, "onChange" | "block"> & {
  content: EmailCardContent;
  fieldPrefix: string;
  onChangeContent: (patch: Partial<EmailCardContent>) => void;
}) {
  const spec = cardSpecFor(content.variant);
  const fg = cardTextColorFor(spec, t);
  const align = cardAlign(content, spec);
  const side = content.imageSide ?? "top";
  const beside = side === "left" || side === "right";
  const split = cardColumnSplit(content);

  const field = (name: string) => `${fieldPrefix}${name}`;
  const shared = {
    editable,
    editingField,
    onStartEditing,
    onStopEditing,
  };

  const imagePart =
    content.imageUrl || beside ? (
      <View>
        {content.imageUrl ? (
          <CanvasImage
            url={content.imageUrl}
            accessibilityLabel={content.imageAlt || "Card image"}
            style={{ borderRadius: cardImageRadius(t) }}
          />
        ) : (
          // An empty slot keeps its geometry rather than collapsing — the same
          // reason `cardImageHtml` returns a tile instead of "".
          <Placeholder theme={t} label="Image" size={CARD_PLACEHOLDER_LABEL_SIZE} variant="card" />
        )}
      </View>
    ) : null;

  const textPart = (
    <View>
      {content.eyebrow !== undefined || (editable && selected) ? (
        <EditableField
          {...shared}
          field={field("eyebrow")}
          value={content.eyebrow ?? ""}
          placeholder="Small line above the heading"
          label="card eyebrow"
          style={{ ...cardEyebrowStyle(t, fg, IS_WEB), textAlign: align }}
          onChangeText={(eyebrow) => onChangeContent({ eyebrow })}
        />
      ) : null}
      <EditableField
        {...shared}
        field={field("heading")}
        value={content.heading ?? ""}
        placeholder="Card heading"
        label="card heading"
        style={{ ...cardHeadingStyle(t, spec, fg, IS_WEB), textAlign: align }}
        onChangeText={(heading) => onChangeContent({ heading })}
      />
      <View style={{ marginBottom: CARD_BODY_MARGIN_BOTTOM }}>
        <EditableField
          {...shared}
          field={field("body")}
          value={content.body ?? ""}
          placeholder="Supports **bold**, *italic*, [links](https://…) and - lists"
          label="card body"
          multiline
          style={{ ...cardBodyStyle(t, content.variant, fg, IS_WEB), textAlign: align }}
          onChangeText={(body) => onChangeContent({ body })}
          renderStatic={() => (
            <CanvasMarkdown
              markdown={content.body ?? ""}
              style={cardBodyStyle(t, content.variant, fg, IS_WEB)}
              linkStyle={linkTextStyle(t)}
              align={align}
            />
          )}
        />
      </View>
      {content.attribution !== undefined ||
      content.variant === "testimonial" ||
      (editable && selected) ? (
        <EditableField
          {...shared}
          field={field("attribution")}
          value={content.attribution ?? ""}
          placeholder="Who said it"
          label="card attribution"
          style={{ ...cardAttributionStyle(t, fg, IS_WEB), textAlign: align }}
          onChangeText={(attribution) => onChangeContent({ attribution })}
        />
      ) : null}
      {content.ctaLabel !== undefined ||
      content.ctaUrl !== undefined ||
      (editable && selected) ? (
        <View
          style={{
            marginTop: CARD_CTA_MARGIN_TOP,
            alignItems: spec.ctaAlign === "center" ? "center" : "flex-start",
          }}
        >
          <View
            style={buttonBoxStyle(t, content.ctaStyle ?? spec.cta, spec.ctaMaxWidth)}
          >
            <EditableField
              {...shared}
              field={field("ctaLabel")}
              value={content.ctaLabel ?? ""}
              placeholder="Read more"
              label="card button label"
              style={buttonLabelStyle(t, content.ctaStyle ?? spec.cta, IS_WEB)}
              onChangeText={(ctaLabel) => onChangeContent({ ctaLabel })}
            />
          </View>
        </View>
      ) : null}
    </View>
  );

  if (!imagePart) return textPart;

  if (!beside) {
    return (
      <View>
        <View style={{ marginBottom: CARD_IMAGE_MARGIN_BOTTOM }}>{imagePart}</View>
        {textPart}
      </View>
    );
  }

  // The asymmetric two-column row (44/56, 52/48 in the real newsletter).
  // Percentages, like the `<td width="…%">` the email uses.
  const imageCell = (
    <View key="image" style={{ width: `${split.imagePct}%` }}>
      {imagePart}
    </View>
  );
  const textCell = (
    <View key="text" style={{ width: `${split.textPct}%` }}>
      {textPart}
    </View>
  );
  const gap = <View key="gap" style={{ width: `${split.gapPct}%` }} />;

  return (
    <View style={{ flexDirection: "row" }}>
      {side === "left" ? [imageCell, gap, textCell] : [textCell, gap, imageCell]}
    </View>
  );
}

/** The dashed neutral band an unfilled image slot draws — the canvas twin of
 *  the renderer's own placeholder, so a template's "the masthead goes here"
 *  looks the same in both places. */
function Placeholder({
  theme: t,
  label,
  size,
  variant,
}: {
  theme: EmailTheme;
  label: string;
  size: number;
  variant: "card" | "bleed";
}) {
  return (
    <View style={variant === "card" ? cardPlaceholderStyle(t) : bleedPlaceholderStyle(t)}>
      <Text style={placeholderLabelStyle(t, size, IS_WEB)}>{label}</Text>
    </View>
  );
}

/** `CanvasEditableText`, wired to this block's editing state. */
function EditableField({
  field,
  value,
  placeholder,
  label,
  style,
  editable,
  editingField,
  onStartEditing,
  onStopEditing,
  onChangeText,
  multiline,
  renderStatic,
  staticPrefix,
}: {
  field: string;
  value: string;
  placeholder: string;
  label: string;
  style: Parameters<typeof CanvasEditableText>[0]["style"];
  editable: boolean;
  editingField: string | null;
  onStartEditing: (field: string) => void;
  onStopEditing: () => void;
  onChangeText: (next: string) => void;
  multiline?: boolean;
  renderStatic?: () => React.ReactNode;
  staticPrefix?: string;
}) {
  return (
    <CanvasEditableText
      value={value}
      placeholder={placeholder}
      style={style}
      editable={editable}
      editing={editingField === field}
      onStartEditing={() => onStartEditing(field)}
      onStopEditing={onStopEditing}
      onChangeText={onChangeText}
      multiline={multiline}
      accessibilityLabel={label}
      renderStatic={renderStatic}
      staticPrefix={staticPrefix}
    />
  );
}
