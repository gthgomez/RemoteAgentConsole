namespace Rac.WindowsPolicy.Helper;

/// <summary>
/// A bounded, non-sensitive failure. The code is the only diagnostic emitted
/// to the caller; exception messages and paths never cross the process boundary.
/// </summary>
internal sealed class PolicyFailureException : Exception
{
    internal PolicyFailureException(string code, int exitCode)
        : base(code)
    {
        Code = code;
        ExitCode = exitCode;
    }

    internal string Code { get; }

    internal int ExitCode { get; }
}
