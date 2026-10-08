# Product design context

## Register

product

## Users and purpose

This desktop application supports live commerce operations. The confirmed audience for the relay screen is a live operator who configures a source before a broadcast and monitors it while OBS consumes the local stream.

The relay screen should make source selection, starting or stopping output, copying the stable OBS address, and checking stream health immediately understandable.

## Personality

Professional, clear, restrained. Preserve the existing application's visual vocabulary rather than introduce a separate brand for relay.

## Design principles

- Put the current workflow and its next action ahead of optional configuration.
- Keep source, output status, and OBS destination together so their relationship is visible.
- Use progressive disclosure for advanced parameters, diagnostics, and maintenance.
- Reduce redundant padding and panel layers before reducing text size.
- Keep errors recognizable through text as well as color.

## Accessibility and inclusion

Use labeled controls, visible keyboard focus, and keyboard-operable disclosures with exposed expansion state. Keep primary form and action text at least 14px and supporting text at least 12px. Respect the existing light/dark theme tokens.

## Boundaries

These decisions were confirmed for the relay UI. Other screens retain their current layout, including the 180px application log panel. Relay alone defaults that panel to a compact, expandable toolbar.
