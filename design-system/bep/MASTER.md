# Bếp interface design

Applied the requested [UI UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) skill from its public repository. The skill was downloaded to `.local-skills/ui-ux-pro-max` for this task, without changing global Codex installation. It can be discovered from that local path in later work.

The food-delivery design-system query matched a culinary consumer marketplace with a prominent hero, clear primary action, structured cards, and accessible interactions. The implementation adapts its palette recommendation to a neighborhood-kitchen identity: forest green, warm cream, restrained terracotta accents, and original food illustrations. This is an intentional project choice, not an exact copy of the generated orange/blue recommendation.

- Primary `#19634d`, hover `#124c3b`, foreground `#20382e`, muted text `#64706a`, background `#fffefa`, borders `#e4e7df`.
- Locally hosted Manrope Variable headings and DM Sans Variable body fonts; serif accent only in the introductory headline.
- Lucide SVG controls, original local SVG food illustrations, no external image dependency.
- Rounded cards with restrained shadows, 1240–1280px desktop content width, responsive one-column mobile views.
- Labeled forms, visible keyboard focus, native modal focus containment/Escape, error and loading states, semantic buttons, reduced-motion support, and an explicit simulation banner.
- Discovery, orders, kitchen management, and operations share the same controls and spacing. Display payment and delivery status separately.

Verification: browser screenshots at desktop/mobile widths; no document overflow at 375/768/1024/1440px; automated accessibility checks on discovery and sign-in. New views should repeat the keyboard, small-screen and form-error checks.
