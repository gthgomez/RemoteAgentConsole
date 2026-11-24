#nullable enable

using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.IO;
using System.Linq;
using System.Text;

namespace RemoteAgentConsole.WindowsLaunch;

/// <summary>
/// An owner-qualified launch contract: one fixed, absolute executable path, a fixed
/// working directory, a fixed argument vector and an explicit frozen environment
/// policy. The contract never resolves PATH, never applies a shell, never expands
/// variables and never reads the parent process environment.
/// </summary>
/// <remarks>
/// Create instances with <see cref="Create"/>. Validation is deliberately pure: the
/// contract does not touch the filesystem, so the owner decides which file was
/// qualified and <c>CreateProcessW</c> remains authoritative for existence.
/// </remarks>
public sealed class LaunchContract
{
    /// <summary>Maximum number of arguments accepted by one contract.</summary>
    public const int MaximumArgumentCount = 1024;

    /// <summary>The documented Windows command-line ceiling, in UTF-16 code units.</summary>
    public const int MaximumCommandLineLength = 32767;

    /// <summary>The documented Windows environment-block ceiling, in UTF-16 code units.</summary>
    public const int MaximumEnvironmentBlockLength = 32767;

    private readonly string[] _arguments;
    private readonly ReadOnlyDictionary<string, string> _environment;

    private LaunchContract(
        string executablePath,
        string workingDirectory,
        string[] arguments,
        ReadOnlyDictionary<string, string> environment,
        string environmentBlock,
        string commandLine)
    {
        ExecutablePath = executablePath;
        WorkingDirectory = workingDirectory;
        _arguments = arguments;
        _environment = environment;
        EnvironmentBlock = environmentBlock;
        CommandLine = commandLine;
    }

    /// <summary>The exact absolute executable path passed as <c>lpApplicationName</c>.</summary>
    public string ExecutablePath { get; }

    /// <summary>The exact absolute working directory passed as <c>lpCurrentDirectory</c>.</summary>
    public string WorkingDirectory { get; }

    /// <summary>The fixed argument vector. The executable path is not part of this list.</summary>
    public IReadOnlyList<string> Arguments => Array.AsReadOnly(_arguments);

    /// <summary>
    /// The frozen environment policy supplied by the caller. This is the complete
    /// environment the child receives; no parent or process environment is merged.
    /// </summary>
    public IReadOnlyDictionary<string, string> Environment => _environment;

    /// <summary>The quoted command line built solely from <see cref="ExecutablePath"/> and <see cref="Arguments"/>.</summary>
    internal string CommandLine { get; }

    /// <summary>The exact double-NUL-terminated Unicode environment block.</summary>
    internal string EnvironmentBlock { get; }

    /// <summary>
    /// Validates and freezes an owner-supplied launch contract.
    /// </summary>
    /// <param name="executablePath">Absolute path to an <c>.exe</c> image already qualified by the owner.</param>
    /// <param name="workingDirectory">Absolute working directory. It is passed through unchanged.</param>
    /// <param name="arguments">Fixed arguments, already qualified by the owner.</param>
    /// <param name="environment">
    /// Complete frozen environment policy. The parent environment is never inherited or
    /// merged. The caller must include every variable the qualified program requires
    /// (for example <c>SystemRoot</c> and any private temporary directory) and must not
    /// include live credentials.
    /// </param>
    /// <exception cref="LaunchContractException">The contract is not a fixed absolute executable/argv/environment contract.</exception>
    public static LaunchContract Create(
        string executablePath,
        string workingDirectory,
        IEnumerable<string>? arguments,
        IReadOnlyDictionary<string, string> environment)
    {
        var exe = ValidateExecutablePath(executablePath);
        var directory = ValidateWorkingDirectory(workingDirectory);
        var frozenEnvironment = FreezeEnvironment(environment);

        var frozen = arguments is null
            ? Array.Empty<string>()
            : new List<string>(arguments).ToArray();

        if (frozen.Length > MaximumArgumentCount)
        {
            throw new LaunchContractException(
                $"The argument vector exceeds the {MaximumArgumentCount}-argument contract limit.");
        }

        for (var index = 0; index < frozen.Length; index++)
        {
            var argument = frozen[index];
            if (argument is null)
            {
                throw new LaunchContractException($"Argument {index} is null.");
            }

            if (argument.Contains('\0', StringComparison.Ordinal))
            {
                throw new LaunchContractException(
                    $"Argument {index} contains a NUL character; an embedded NUL would truncate the command line.");
            }
        }

        var rawCommandLineLength = (long)exe.Length;
        foreach (var argument in frozen)
        {
            rawCommandLineLength += argument.Length + 1L;
        }

        if (rawCommandLineLength >= MaximumCommandLineLength)
        {
            throw new LaunchContractException(
                $"The raw command line is at least {rawCommandLineLength} characters; quoting cannot fit the Windows ceiling.");
        }

        var commandLine = CommandLineBuilder.Build(exe, frozen);
        if (commandLine.Length >= MaximumCommandLineLength)
        {
            throw new LaunchContractException(
                $"The quoted command line is {commandLine.Length} characters; the Windows ceiling is {MaximumCommandLineLength - 1}.");
        }

        var environmentBlock = BuildEnvironmentBlock(frozenEnvironment);
        return new LaunchContract(exe, directory, frozen, frozenEnvironment, environmentBlock, commandLine);
    }

    private static ReadOnlyDictionary<string, string> FreezeEnvironment(IReadOnlyDictionary<string, string>? environment)
    {
        if (environment is null)
        {
            throw new LaunchContractException(
                "An explicit environment policy is required; the parent environment is never inherited.");
        }

        var frozen = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in environment)
        {
            var key = entry.Key;
            if (string.IsNullOrEmpty(key))
            {
                throw new LaunchContractException("Environment variable names must not be empty.");
            }

            if (key.Contains('=', StringComparison.Ordinal) || key.Contains('\0', StringComparison.Ordinal))
            {
                throw new LaunchContractException($"Environment variable name '{key}' contains a disallowed character.");
            }

            if (entry.Value is null)
            {
                throw new LaunchContractException($"Environment variable '{key}' has a null value.");
            }

            if (entry.Value.Contains('\0', StringComparison.Ordinal))
            {
                throw new LaunchContractException($"Environment variable '{key}' contains a NUL character.");
            }

            if (!frozen.TryAdd(key, entry.Value))
            {
                throw new LaunchContractException(
                    $"Environment variable '{key}' is duplicated case-insensitively; the policy must be unambiguous.");
            }
        }

        return new ReadOnlyDictionary<string, string>(frozen);
    }

    private static string BuildEnvironmentBlock(ReadOnlyDictionary<string, string> environment)
    {
        long bodyLength = 0;
        var entries = new List<string>(environment.Count);
        foreach (var entry in environment.OrderBy(item => item.Key, StringComparer.OrdinalIgnoreCase))
        {
            var entryLength = (long)entry.Key.Length + 1 + entry.Value.Length + 1;
            bodyLength += entryLength;
            if (bodyLength + 1 > MaximumEnvironmentBlockLength)
            {
                throw new LaunchContractException(
                    $"The environment block is at least {bodyLength + 1} characters; the Windows ceiling is {MaximumEnvironmentBlockLength}.");
            }

            entries.Add($"{entry.Key}={entry.Value}");
        }

        // Each entry is NUL-terminated and the block ends with a second NUL.
        var block = string.Join('\0', entries) + "\0\0";
        if (block.Length > MaximumEnvironmentBlockLength)
        {
            throw new LaunchContractException(
                $"The environment block is {block.Length} characters; the Windows ceiling is {MaximumEnvironmentBlockLength}.");
        }

        return block;
    }

    private static string ValidateExecutablePath(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new LaunchContractException("An absolute executable path is required.");
        }

        RejectEmbeddedCharacters(path, "executable path");
        if (!Path.IsPathFullyQualified(path))
        {
            throw new LaunchContractException($"The executable path must be absolute: '{path}'.");
        }

        if (!string.Equals(Path.GetExtension(path), ".exe", StringComparison.OrdinalIgnoreCase))
        {
            throw new LaunchContractException(
                $"The executable path must name an .exe image so Windows never appends an extension: '{path}'.");
        }

        var fileName = Path.GetFileName(path);
        if (fileName.Length == 0
            || fileName.EndsWith(' ')
            || fileName.EndsWith('.')
            || fileName.Contains('"', StringComparison.Ordinal))
        {
            throw new LaunchContractException($"The executable file name is not an exact Win32 path: '{path}'.");
        }

        return path;
    }

    private static string ValidateWorkingDirectory(string? directory)
    {
        if (string.IsNullOrWhiteSpace(directory))
        {
            throw new LaunchContractException("An absolute working directory is required.");
        }

        RejectEmbeddedCharacters(directory, "working directory");
        if (!Path.IsPathFullyQualified(directory))
        {
            throw new LaunchContractException($"The working directory must be absolute: '{directory}'.");
        }

        return directory;
    }

    private static void RejectEmbeddedCharacters(string value, string description)
    {
        for (var index = 0; index < value.Length; index++)
        {
            var character = value[index];
            if (character == '\0')
            {
                throw new LaunchContractException($"The {description} contains a NUL character.");
            }

            if (character < ' ' || character == '"')
            {
                throw new LaunchContractException(
                    $"The {description} contains a disallowed character U+{(int)character:X4} at index {index}.");
            }
        }
    }
}

/// <summary>
/// Raised before any native resource is created when a launch contract is not a
/// fixed absolute executable/argv/environment contract.
/// </summary>
public sealed class LaunchContractException : ArgumentException
{
    /// <summary>Creates the exception.</summary>
    public LaunchContractException(string message)
        : base(message)
    {
    }
}

/// <summary>
/// Builds a Windows command line using the quoting rules understood by the default
/// C runtime / <c>CommandLineToArgvW</c> argument parser.
/// </summary>
internal static class CommandLineBuilder
{
    internal static string Build(string executablePath, IReadOnlyList<string> arguments)
    {
        var builder = new StringBuilder(executablePath.Length + 16);
        AppendQuoted(builder, executablePath);
        for (var index = 0; index < arguments.Count; index++)
        {
            builder.Append(' ');
            AppendQuoted(builder, arguments[index]);
        }

        return builder.ToString();
    }

    internal static void AppendQuoted(StringBuilder builder, string value)
    {
        if (value.Length > 0 && !NeedsQuoting(value))
        {
            builder.Append(value);
            return;
        }

        builder.Append('"');
        var backslashes = 0;
        foreach (var character in value)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }

            if (character == '"')
            {
                builder.Append('\\', (backslashes * 2) + 1);
                builder.Append('"');
                backslashes = 0;
                continue;
            }

            builder.Append('\\', backslashes);
            backslashes = 0;
            builder.Append(character);
        }

        builder.Append('\\', backslashes * 2);
        builder.Append('"');
    }

    private static bool NeedsQuoting(string value)
    {
        foreach (var character in value)
        {
            if (character is ' ' or '\t' or '"' or '\n' or '\r')
            {
                return true;
            }
        }

        return false;
    }
}
