"""build_vsix – package the monarch VS Code extension as .vsix without npm."""

# --------- IMPORTS ---------
import json
import traceback
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

# --------- STATIC ---------
content_types = {".json": "application/json", ".js": "application/javascript", ".md": "text/markdown", ".css": "text/css", ".svg": "image/svg+xml", ".vsixmanifest": "text/xml"}
package_dirs = ("src", "media")

# --------- CONFIG ---------
app_name = "build_vsix"
app_version = "0.1"
extension_dir = Path(__file__).parent
readme_file = extension_dir.parent / "README.md"


# --------- FUNC ---------
def collect_files() -> dict[str, Path]:
    """Return {path inside the vsix: source file}."""
    files = {"extension/package.json": extension_dir / "package.json"}
    if readme_file.is_file():
        files["extension/README.md"] = readme_file
    for folder in package_dirs:
        files |= {f"extension/{path.relative_to(extension_dir).as_posix()}": path for path in sorted((extension_dir / folder).rglob("*")) if path.is_file()}
    return files


def build_manifest(package: dict, has_readme: bool) -> str:
    readme_asset = '<Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/>' if has_readme else ""
    return f"""<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{escape(package['name'])}" Version="{escape(package['version'])}" Publisher="{escape(package['publisher'])}"/>
    <DisplayName>{escape(package.get('displayName', package['name']))}</DisplayName>
    <Description xml:space="preserve">{escape(package.get('description', ''))}</Description>
    <Categories>{escape(','.join(package.get('categories', [])))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{escape(package['engines']['vscode'])}"/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/>
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="{escape(','.join(package.get('extensionKind', ['workspace'])))}"/>
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value=""/>
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>
    {readme_asset}
  </Assets>
</PackageManifest>
"""


def build_content_types(paths: list[str]) -> str:
    suffixes = sorted({Path(path).suffix for path in paths} | {".vsixmanifest"})
    defaults = "".join(f'<Default Extension="{suffix}" ContentType="{content_types.get(suffix, "application/octet-stream")}"/>' for suffix in suffixes if suffix)
    return f'<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">{defaults}</Types>'


# --------- MAIN ---------
def main():
    package = json.loads((extension_dir / "package.json").read_text(encoding="utf-8"))
    files = collect_files()
    target = extension_dir / f"{package['name']}-{package['version']}.vsix"
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("extension.vsixmanifest", build_manifest(package, "extension/README.md" in files))
        archive.writestr("[Content_Types].xml", build_content_types(list(files)))
        for name, source in files.items():
            archive.write(source, name)
    print(f"{app_name}: {target.name} ({len(files)} files)")


# --------- EXEC ---------
if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Unhandled error in main: {exc}")
        print(traceback.format_exc())
