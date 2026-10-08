# Relay visual design

## Theme and typography

Reuse the application's existing Tailwind semantic colors (`background`, `card`,
`muted`, `foreground`, `primary`, `destructive`, `border`, and `ring`), current
font stack, and Radix/shadcn components. Preserve light/dark variants. Use
monospace for addresses and detailed logs only.

The page heading is 24px, primary form and action text is 14px or larger, and
supporting labels are 12px. Error information includes an explicit text label
rather than color alone.

## Layout and spacing

Relay uses 16px main padding, 12px separation between sections, and 8–12px
between related controls. One bordered work area contains source configuration,
output controls, a status strip, and the OBS destination. Internal separators
replace stacked and nested cards.

Flexible rows wrap as the available content width shrinks. Inputs and long
strings must shrink or wrap without pushing the main area horizontally. At
1280×800, the default collapsed view keeps the principal controls, OBS address,
and four status values visible together.

## Progressive disclosure

Advanced settings, LAN addresses, and maintenance begin collapsed. Cookie input
starts at three lines and can resize vertically. Maintenance distinguishes
stopping output from shutting down the backend service.

Relay logs begin as a 40px summary toolbar with count, latest message, and an
error count when relevant; the expanded list is 160px high. Application logs
begin as a 40px toolbar on relay and expand to the existing 180px panel. Logs
continue collecting while collapsed; expansion restores automatic scrolling when
enabled.

## Controls

Use existing buttons, input fields, selects, tooltips, popovers, and
collapsibles. Keep the start action visually primary, stop secondary, and
backend shutdown destructive inside maintenance. Disclosures expose expanded
state and rotate their chevrons. Preserve visible focus and accessible names for
icon-only controls.
