# Helpers the preflight and the bootstrap share. Sourced, never run.
# Everything said to the operator goes to stderr; stdout is left to the commands' own output.

say()  { printf '%s\n' "$*" >&2; }
ok()   { printf 'ok   %s\n' "$*" >&2; }
warn() { printf 'warn %s\n' "$*" >&2; }
fail() { printf 'fail %s\n' "$*" >&2; exit 1; }

interactive() { [ -t 0 ]; }

# ask VAR "question" [default]
# An answer already in the environment (or loaded from saved settings) is used as it is. With a
# terminal, the question is asked and an empty reply takes the default. Without one, the default
# is taken, and a question with no default stops the run naming the variable to set.
ask() {
  local -n _ask_ref="$1"
  local question="$2" default="${3-}" reply
  if [ -n "${_ask_ref:-}" ]; then return 0; fi
  if interactive; then
    while :; do
      if [ -n "$default" ]; then read -r -p "$question [$default] " reply >&2 || reply=""; else read -r -p "$question " reply >&2 || reply=""; fi
      reply="${reply:-$default}"
      [ -n "$reply" ] && break
      say "an answer is needed"
    done
    _ask_ref="$reply"
  elif [ -n "$default" ]; then
    _ask_ref="$default"
  else
    fail "$1 is not set and there is no terminal to ask \"$question\"; set $1 and run again"
  fi
}

# ask_optional VAR "question" [default] — as ask, but an empty answer is an answer, and a variable
# that is set, even to nothing, has been answered.
ask_optional() {
  local -n _opt_ref="$1"
  local question="$2" default="${3-}" reply
  if [ -n "${_opt_ref+set}" ]; then return 0; fi
  if interactive; then
    read -r -p "$question [${default:-blank to skip}] " reply >&2 || reply=""
    if [ "$reply" = "-" ]; then reply=""; else reply="${reply:-$default}"; fi
    _opt_ref="$reply"
  else
    _opt_ref="$default"
  fi
}

# choose VAR "question" default option...
choose() {
  local -n _choose_ref="$1"
  local question="$2" default="$3"; shift 3
  local options=("$@") o reply
  if [ -z "${_choose_ref:-}" ]; then
    if interactive; then
      while [ -z "${_choose_ref:-}" ]; do
        read -r -p "$question (${options[*]}) [$default] " reply >&2 || reply=""
        reply="${reply:-$default}"
        for o in "${options[@]}"; do [ "$reply" = "$o" ] && _choose_ref="$reply"; done
        [ -n "${_choose_ref:-}" ] || say "one of: ${options[*]}"
      done
    else
      _choose_ref="$default"
    fi
  fi
  for o in "${options[@]}"; do [ "$_choose_ref" = "$o" ] && return 0; done
  fail "$question: \"$_choose_ref\" is not one of ${options[*]}"
}

# confirm "question" y|n — yes or no; without a terminal, the default.
confirm() {
  local question="$1" default="$2" reply
  if ! interactive; then [ "$default" = y ]; return; fi
  read -r -p "$question [$([ "$default" = y ] && echo Y/n || echo y/N)] " reply >&2 || reply=""
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy] ]]
}

# The last path segment of a resource id, or the value itself when it is already a name.
name_of() { printf '%s' "${1##*/}"; }

# Lowercase letters, digits and hyphens, at most $2 characters, never ending in a hyphen.
slug() {
  local s
  s="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed -E 's/-+/-/g; s/^-//')"
  s="${s:0:${2:-24}}"
  printf '%s' "${s%-}"
}

# A settings value is a name, an id, a region or a list of logins: nothing that needs quoting.
safe_value() { [[ "$1" =~ ^[A-Za-z0-9/._:,@-]*$ ]]; }
