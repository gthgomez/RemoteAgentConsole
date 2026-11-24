using System.Text.Json;
using System.Text.Json.Serialization;

namespace Rac.WindowsPolicy.Helper;

internal static class Program
{
    private const int ExitOk = 0;
    private const int ExitInvalid = 2;
    private const int ExitDenied = 3;
    private const int ExitError = 4;

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = false,
    };

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length != 1)
            {
                return EmitError(ExitInvalid, "usage");
            }

            LaunchEnvironment.Validate();
            var snapshot = PolicyFileReader.Read(args[0]);
            return Emit(snapshot, ExitOk);
        }
        catch (PolicyFailureException failure)
        {
            return EmitError(failure.ExitCode, failure.Code);
        }
        catch (ArgumentException)
        {
            return EmitError(ExitInvalid, "input-invalid");
        }
        catch (UnauthorizedAccessException)
        {
            return EmitError(ExitDenied, "access-denied");
        }
        catch (IOException)
        {
            return EmitError(ExitError, "io-error");
        }
        catch (Exception)
        {
            // Never surface a path, SID, ACL, exception message or stack trace.
            return EmitError(ExitError, "internal");
        }
    }

    private static int EmitError(int exitCode, string code)
    {
        var status = exitCode switch
        {
            ExitInvalid => "invalid",
            ExitDenied => "denied",
            _ => "error",
        };

        return Emit(new ErrorSnapshot(1, status, code), exitCode);
    }

    private static int Emit<T>(T payload, int exitCode)
    {
        try
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(payload, JsonOptions);
            var stdout = Console.OpenStandardOutput();
            stdout.Write(bytes);
            stdout.WriteByte((byte)'\n');
            stdout.Flush();
            return exitCode;
        }
        catch
        {
            return ExitError;
        }
    }
}
