# ADR-0010: No generic remote shell in the MVP

Status: Accepted

Do not expose shell, exec, or PowerShell endpoints. Coding runtimes already provide tools governed by their own permission systems; an independent shell endpoint would bypass that authority.
