/**
 * dsh-session-dock host entry.
 *
 * The dock is a pure client plugin (it renders in the browser via
 * `lib/client.js`); the host side only needs to exist so the bundle mounts as
 * a profile layer and the client-modules scan picks up the package's
 * `dsh.client` declaration.
 */

const name = "dsh-session-dock";

function apply(_ctx) {
  // Nothing host-side to do: the web client renders the dock and reads the
  // sessions service directly through the client context.
}

export { name, apply };
