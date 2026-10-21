# Licence and notices

**This program is licensed under the GNU Affero General Public License,
version 3 or (at your option) any later version.** The full text is in
[`LICENSE`](LICENSE).

## Why the AGPL, specifically

The AGPL was chosen because this program has a **remote network
interface**: the board dashboard (`packages/adapter-opencode/src/web/`)
serves over HTTP, and the plugin runs inside a long-lived server that
interacts with users over a network.

The AGPL's section 13 is the part that matters here. If you modify this
program and run your modified version so that users interact with it
remotely over a computer network, you must **offer those users the
Corresponding Source** of your modified version.

**What that obliges the operator of a modified instance to do:** provide a
prominent way for the people using it to get the source. The dashboard
therefore carries a **Source** link, which points at the public repository.
That is the "interface must display Appropriate Legal Notices" and
"offer access to the Corresponding Source" requirement of sections 5(d)
and 6(d), applied to a server that is reached over a network.

**What it obliges a distributor to do:** convey the source, keep the
notices intact, and license the whole work under the AGPL. The
`LICENSE` file travels inside the tarball for exactly this reason: section
4 requires that every recipient is given a copy of the licence along with
the program.

## Third-party dependencies

Third-party dependencies retain their respective licences. They are not
covered by this grant, and they are not relicensed by it. The generated
licence inventory (`release/evidence/licenses.json`) lists every installed
package and its declared licence, and the SBOM (`release/sbom.json`) records
the same set in CycloneDX form.

At the time of this release every third-party dependency in the tree is MIT
licensed, and the dependency audit reports no peer conflict, no declared-range
violation and no unknown licence.

## The plugin's identity

The npm package name is `@nexussean/opencode-project-intelligence`. The
**runtime** identifier — the plugin id, the skill id, and the directory
under `XDG_DATA_HOME` that holds the registry — is deliberately **not** the
same string: it remains `opencode-project-intelligence`.

That is not an oversight. The runtime identifier is where an existing
installation's data lives, and changing it would orphan every existing
registry, project and task. The two names are kept distinct so that the
package can be renamed and scoped without moving anyone's data.
