namespace Rac.WindowsPolicy.Helper;

/// <summary>
/// Strict parser for the only path shape this helper accepts: an absolute,
/// fully-qualified local drive path below the drive root, using backslashes and
/// no Win32 alias/device syntax. Anything that can change meaning under a later
/// path resolution is rejected before the filesystem is touched.
/// </summary>
internal sealed record PolicyPath(
    string DriveRoot,
    string[] Components,
    string NormalizedPath,
    string DirectoryPath)
{
    // Deliberately bounded below NT's 32767-character ceiling. A policy file
    // lives in a short, deployment-owned directory; these limits keep the
    // caller's allocation and handle chain bounded.
    internal const int MaxPathCharacters = 8192;
    internal const int MaxPathComponents = 64;
    internal const int MaxComponentCharacters = 255;

    private static readonly HashSet<string> ReservedDeviceNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "CON", "PRN", "AUX", "NUL",
        "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
        "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        "CONIN$", "CONOUT$",
    };

    internal static PolicyPath Parse(string? input)
    {
        if (string.IsNullOrEmpty(input))
        {
            throw Invalid("input-empty");
        }

        if (input.Length > MaxPathCharacters)
        {
            throw Invalid("input-too-long");
        }

        if (input.IndexOf('\0') >= 0)
        {
            throw Invalid("input-invalid");
        }

        if (input.Length < 3
            || !IsAsciiLetter(input[0])
            || input[1] != ':'
            || input[2] != '\\')
        {
            throw Invalid("input-not-drive-absolute");
        }

        if (input.Length == 3)
        {
            throw Invalid("input-drive-root");
        }

        if (input.IndexOf('/') >= 0)
        {
            throw Invalid("input-alternate");
        }

        for (var index = 2; index < input.Length; index++)
        {
            var character = input[index];
            if (char.IsControl(character)
                || character is '<' or '>' or ':' or '"' or '|' or '?' or '*')
            {
                throw Invalid("input-alternate");
            }
        }

        var driveRoot = char.ToUpperInvariant(input[0]) + ":\\";
        var components = input[3..].Split('\\');
        if (components.Length == 0 || components.Any(component => component.Length == 0))
        {
            throw Invalid("input-component-invalid");
        }

        if (components.Length > MaxPathComponents)
        {
            throw Invalid("input-too-deep");
        }

        foreach (var component in components)
        {
            if (component.Length > MaxComponentCharacters
                || component == "."
                || component == ".."
                || component != component.Trim()
                || component.EndsWith('.')
                || component.EndsWith(' '))
            {
                throw Invalid("input-component-invalid");
            }

            var baseName = component.Split('.')[0].TrimEnd(' ', '.');
            if (ReservedDeviceNames.Contains(baseName))
            {
                throw Invalid("input-alternate");
            }
        }

        var normalizedPath = driveRoot + string.Join('\\', components);
        if (normalizedPath.Length > MaxPathCharacters)
        {
            throw Invalid("input-too-long");
        }

        var directoryPath = components.Length == 1
            ? driveRoot
            : driveRoot + string.Join('\\', components[..^1]);

        return new PolicyPath(driveRoot, components, normalizedPath, directoryPath);
    }

    private static bool IsAsciiLetter(char value) =>
        value is >= 'A' and <= 'Z' or >= 'a' and <= 'z';

    private static PolicyFailureException Invalid(string code) => new(code, 2);
}
