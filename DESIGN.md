---
name: DigitalBurj Restaurant & Food Service OS
description: Fig & Pear identity for restaurant operations
colors:
  fig: "#4b2943"
  pear: "#d8d77c"
  porcelain: "#f5f0e7"
  mushroom: "#c9baa8"
  ink: "#211d21"
  muted: "#68605f"
  line: "#e1d8cb"
  surface: "#fffdfa"
  success: "#2f654f"
  warning: "#875721"
  danger: "#a23e44"
typography:
  display:
    fontFamily: "Fraunces Variable, serif"
    fontSize: "36px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Manrope Variable, sans-serif"
    fontSize: "16px"
    fontWeight: 750
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Manrope Variable, sans-serif"
    fontSize: "14px"
    lineHeight: 1.55
  label:
    fontFamily: "Manrope Variable, sans-serif"
    fontSize: "11px"
    fontWeight: 700
rounded:
  badge: "5px"
  navigation: "7px"
  control: "8px"
  floating: "10px"
  panel: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.fig}"
    textColor: "{colors.porcelain}"
    rounded: "{rounded.control}"
    padding: "10px 15px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "#613554"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "10px 15px"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.panel}"
  navigation-active:
    backgroundColor: "{colors.pear}"
    textColor: "{colors.fig}"
    rounded: "{rounded.navigation}"
    padding: "10px 12px"
  status-success:
    backgroundColor: "#e4ede6"
    textColor: "{colors.success}"
    rounded: "{rounded.badge}"
    padding: "4px 7px"
---

# Design System: DigitalBurj

## Overview

The supplied Fig & Pear guidelines are the visual authority. Porcelain workspaces, deep fig navigation, pear selection and restrained warm rules give operational screens a consistent identity. Manrope carries interface and numeric work; Fraunces marks prominent titles. The implemented DigitalBurj name is typography, not an invented logo.

This document completes the initial implementation's provisional design notes. It records observed styles in `src/style.css` and shared patterns in `src/ui.tsx`, `src/App.tsx` and `src/screens.tsx`; it does not introduce a replacement brand or new product behavior.

**Key characteristics:** warm neutral surfaces; compact, scanable operational rows; explicit status and feedback; contextual side sheets.

## Colors

### Primary

- **Fig:** persistent navigation, primary buttons, prominent totals and text links.
- **Pear:** selected navigation, brand punctuation and selection highlights. The implemented primary action button uses fig.

### Neutral

- **Porcelain:** application background and light text on fig.
- **Surface:** panels, fields, header and drawers.
- **Mushroom:** field outlines and warm separators in selected contexts.
- **Line:** default panel and table rules.
- **Ink / Muted:** primary and secondary interface text.

### Semantic

Success, warning and danger use readable colored text with pale tonal backgrounds; text labels accompany status dots. Brand brass (#C3A76C) and information (#365E7D) remain supplied/provisional palette references, not extracted CSS primitives; do not introduce them into current components without a concrete use.

## Typography

Use `Manrope Variable, sans-serif` throughout UI and `Fraunces Variable, serif` for page, login and drawer titles. Default body is 14px/1.55; operational text varies from 9–13px on desktop. Panel titles are 16px/750. Page titles are 36px/600, adapting to 31–32px at smaller sizes and 40px above 1550px. Prominent login titles use 65px desktop and 40px mobile. Totals use tabular numerals, compact tracking and strong weight. Critical mobile status and supporting operational text are enlarged by the final 760px override; consult the cascade before copying a desktop size.

## Layout

The default fixed sidebar is 244px, with a 72px header and content padding 33px 34px 24px, capped at 1800px. Dashboard columns use `minmax(0,1.65fr) minmax(290px,1fr)` with a 24px gap. Metric strips use four divided cells. Panels separate content with rules rather than extra nested boxes.

At 1200px sidebar width becomes 220px; at 980px main grids stack and metric/report grids use two columns. At 760px the sidebar becomes an explicitly controlled overlay, header becomes 61px and content uses 25px 18px 18px padding. Navigation supports keyboard dismissal and focus restoration. Tables scroll inside `.table-wrap`. POS products become two columns and the basket stacks; kitchen tickets and guest order layouts become single columns. Above 1550px navigation expands to 260px and content uses 38px 50px. Drawers are up to 510px (wide: 750px), bounded by viewport width.

## Elevation & Depth

Panels are flat, defined by surface contrast and 1px warm rules. Shadows identify transient UI: toast `0 8px 28px #211d212b`, drawer `-8px 0 40px #211d2126`, notifications `0 6px 25px #211d212b`. Modal and mobile-navigation backdrops use `#211d2173`.

## Shapes

Use 8px controls, 12px panels, 7px navigation items and 5px compact status badges. Circular avatars and status dots are limited to identity/state cues. Field outlines use 1px mushroom; panel outlines use line. Corners stay modest and functional.

## Components

### Buttons

Primary buttons use fig with porcelain text; secondary buttons use surface with a warm outline. Both use 13px/700 type, 10px 15px padding, 8px corners and a 40px minimum height. Primary hover is #613554; secondary hover is #eee6d9. Disabled buttons reduce opacity to .5. Text buttons underline on hover. Keyboard focus is a 3px #94862c outline offset 3px.

### Fields

Inputs, selects and textareas use surface, ink, 8px corners and 10px 12px padding. Focus uses a 2px fig outline offset 2px. Shared Field provides a visible label and optional hint; form-specific validation is visible through ErrorBox. Do not imply validation or disabled styles beyond what the implementation supplies.

### Panels, tables and status

Shared Panel uses a surface background, line outline, 12px radius and clipped contents. Headers use 21px 22px 17px padding. Data tables have pale headers, horizontal separators and local overflow. Status uses labeled text and a current-color dot; success, pending and problem states have distinct tonal backgrounds. Empty, Loading and ErrorBox explicitly represent missing data, in-flight work and failures.

### Navigation and tabs

Sidebar groups have compact uppercase labels and icon/text links. Active navigation uses pear with fig text; hover uses #603852. Tabs use a fig underline and `aria-selected`; overflow remains local. Mobile navigation exposes open and close controls and a dismissal scrim.

### Side sheets and feedback

Drawer preserves workspace context, traps focus, closes with Escape or backdrop click, restores previous focus and locks background scrolling. Header uses Fraunces at 21px. Toast gives visible mutation feedback. Motion uses 160ms button/navigation transitions and a 200ms drawer entrance with `cubic-bezier(.16,1,.3,1)`; reduced-motion preferences remove animation and transitions.

## Do's and Don'ts

- **Do** preserve the supplied palette and typography; extract new shared patterns from the implementation.
- **Do** keep monetary totals tabular, status text explicit and financial evidence accessible through record views.
- **Do** retain keyboard-visible focus, labeled fields, local table overflow and reduced-motion handling.
- **Don't** invent a logo or replace the user's identity.
- **Don't** change demo labels, integration scope or operational behavior as a visual embellishment.
- **Don't** use panel shadows as decoration; reserve depth for transient overlays.
