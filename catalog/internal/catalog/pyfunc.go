package catalog

// A Python function as an operator. A team keeps the Python it reuses as functions:
//
//	@returns(patient_id=str, time_in_range=float)
//	def cgm_metrics(readings: pd.DataFrame, *, tir_low: int = 70, tir_high: int = 180) -> pd.DataFrame:
//	    """Time in range, one row per patient."""
//
// Its positional parameters are its inputs, one table each; its parameters with defaults, and
// those after a bare *, are its settings; its docstring is its description; @returns names its
// output columns and their types, and with nondeterministic=True says the function may give
// other rows for the same input. The catalog reads them from the code when the operator is
// saved, so every client that saves the code gets the same operator.

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"

	"github.com/apache/texera/catalog/internal/api"
)

// pyFunction is what a function's definition says of the operator it is.
type pyFunction struct {
	Name     string
	Doc      string
	Inputs   []string
	Settings []pySetting
	Returns  []api.Attribute
	// Nondeterministic: the function may give other rows for the same input.
	Nondeterministic bool
}

// pySetting is one of a function's settings, as a JSON Schema property.
type pySetting struct {
	Name     string
	Schema   map[string]any
	Required bool
}

// bySetting is the setting every function operator has: the columns whose rows reach one call
// together, each group whole on one worker.
const bySetting = "by"

type pyToken struct {
	kind string // name, number, string, op, newline, end
	text string
	line int
	col  int
}

// pyTokens reads Python source into tokens, enough to read a definition: names, numbers,
// strings, operators, and the end of each logical line. Comments are skipped, and a line break
// inside brackets continues the line, as in Python.
func pyTokens(code string) ([]pyToken, error) {
	var out []pyToken
	src := []rune(code)
	line, col, depth := 1, 0, 0
	i := 0
	advance := func(n int) {
		for k := 0; k < n && i < len(src); k++ {
			if src[i] == '\n' {
				line++
				col = 0
			} else {
				col++
			}
			i++
		}
	}
	for i < len(src) {
		c := src[i]
		switch {
		case c == '#':
			for i < len(src) && src[i] != '\n' {
				advance(1)
			}
		case c == '\\' && i+1 < len(src) && src[i+1] == '\n':
			advance(2)
		case c == '\n':
			if depth == 0 {
				out = append(out, pyToken{kind: "newline", line: line, col: col})
			}
			advance(1)
		case unicode.IsSpace(c):
			advance(1)
		case c == '"' || c == '\'' || ((c == 'r' || c == 'b' || c == 'f' || c == 'u' || c == 'R' || c == 'B' || c == 'F' || c == 'U') && i+1 < len(src) && (src[i+1] == '"' || src[i+1] == '\'')):
			startLine, startCol := line, col
			raw := false
			if c != '"' && c != '\'' {
				raw = c == 'r' || c == 'R'
				advance(1)
			}
			q := src[i]
			triple := i+2 < len(src) && src[i+1] == q && src[i+2] == q
			var sb strings.Builder
			if triple {
				advance(3)
				for {
					if i+2 >= len(src) {
						return nil, fmt.Errorf("line %d: a string is not closed", startLine)
					}
					if src[i] == q && src[i+1] == q && src[i+2] == q {
						advance(3)
						break
					}
					if src[i] == '\\' && !raw && i+1 < len(src) {
						sb.WriteRune(unescape(src[i+1]))
						advance(2)
						continue
					}
					sb.WriteRune(src[i])
					advance(1)
				}
			} else {
				advance(1)
				for {
					if i >= len(src) || src[i] == '\n' {
						return nil, fmt.Errorf("line %d: a string is not closed", startLine)
					}
					if src[i] == q {
						advance(1)
						break
					}
					if src[i] == '\\' && !raw && i+1 < len(src) {
						sb.WriteRune(unescape(src[i+1]))
						advance(2)
						continue
					}
					sb.WriteRune(src[i])
					advance(1)
				}
			}
			out = append(out, pyToken{kind: "string", text: sb.String(), line: startLine, col: startCol})
		case c == '_' || unicode.IsLetter(c):
			start, startCol := i, col
			for i < len(src) && (src[i] == '_' || unicode.IsLetter(src[i]) || unicode.IsDigit(src[i])) {
				advance(1)
			}
			out = append(out, pyToken{kind: "name", text: string(src[start:i]), line: line, col: startCol})
		case unicode.IsDigit(c) || (c == '.' && i+1 < len(src) && unicode.IsDigit(src[i+1])):
			start, startCol := i, col
			for i < len(src) && (unicode.IsDigit(src[i]) || src[i] == '.' || src[i] == '_' || src[i] == 'e' || src[i] == 'E' || src[i] == 'x' || src[i] == 'o' ||
				((src[i] == '+' || src[i] == '-') && (src[i-1] == 'e' || src[i-1] == 'E')) || (src[i] >= 'a' && src[i] <= 'f') || (src[i] >= 'A' && src[i] <= 'F')) {
				advance(1)
			}
			out = append(out, pyToken{kind: "number", text: string(src[start:i]), line: line, col: startCol})
		default:
			startCol := col
			op := string(c)
			for _, two := range []string{"->", "**", "//", "==", "!=", "<=", ">=", ":="} {
				if strings.HasPrefix(string(src[i:min(i+2, len(src))]), two) {
					op = two
					break
				}
			}
			switch op {
			case "(", "[", "{":
				depth++
			case ")", "]", "}":
				if depth > 0 {
					depth--
				}
			}
			out = append(out, pyToken{kind: "op", text: op, line: line, col: startCol})
			advance(len([]rune(op)))
		}
	}
	out = append(out, pyToken{kind: "newline", line: line, col: col}, pyToken{kind: "end", line: line, col: col})
	return out, nil
}

func unescape(c rune) rune {
	switch c {
	case 'n':
		return '\n'
	case 't':
		return '\t'
	case 'r':
		return '\r'
	case '0':
		return 0
	}
	return c
}

// pyLine is a logical line: its tokens, without the newline, and the column it starts at.
type pyLine struct {
	tokens []pyToken
	col    int
}

func pyLines(tokens []pyToken) []pyLine {
	var out []pyLine
	var cur []pyToken
	for _, t := range tokens {
		if t.kind == "newline" || t.kind == "end" {
			if len(cur) > 0 {
				out = append(out, pyLine{tokens: cur, col: cur[0].col})
				cur = nil
			}
			continue
		}
		cur = append(cur, t)
	}
	return out
}

// parsePyFunction reads what the top-level function `name` in code says of its operator.
func parsePyFunction(code, name string) (*pyFunction, error) {
	tokens, err := pyTokens(code)
	if err != nil {
		return nil, err
	}
	lines := pyLines(tokens)
	at := -1
	for i, l := range lines {
		if l.col == 0 && len(l.tokens) >= 2 && l.tokens[0].text == "def" && l.tokens[1].text == name {
			at = i
		}
	}
	if at < 0 {
		return nil, fmt.Errorf("the code has no function %s at its top level", name)
	}
	fn := &pyFunction{Name: name}
	def := lines[at]

	// @returns, among the decorators right above the def.
	found := false
	for i := at - 1; i >= 0 && lines[i].col == 0 && lines[i].tokens[0].text == "@"; i-- {
		d := lines[i].tokens
		if len(d) >= 3 && d[1].text == "returns" && d[2].text == "(" {
			if err := fn.readReturns(d[3:]); err != nil {
				return nil, fmt.Errorf("line %d: %w", d[0].line, err)
			}
			found = true
		}
	}
	if !found {
		return nil, fmt.Errorf("%s has no @returns: name its output columns and their types above it, as @returns(patient_id=str, mean=float)", name)
	}

	// The parameters, between the def's parentheses.
	if len(def.tokens) < 3 || def.tokens[2].text != "(" {
		return nil, fmt.Errorf("line %d: def %s is not followed by its parameters", def.tokens[0].line, name)
	}
	params, err := splitTop(def.tokens[3:], ")")
	if err != nil {
		return nil, fmt.Errorf("line %d: %w", def.tokens[0].line, err)
	}
	keywordOnly := false
	for _, p := range params {
		if len(p) == 0 {
			continue
		}
		switch {
		case p[0].text == "/" && len(p) == 1:
			continue
		case p[0].text == "*" && len(p) == 1:
			keywordOnly = true
			continue
		case p[0].text == "*" || p[0].text == "**":
			return nil, fmt.Errorf("line %d: %s takes no %s%s: name each input and each setting", p[0].line, name, p[0].text, p[1].text)
		case p[0].kind != "name":
			return nil, fmt.Errorf("line %d: %q is not a parameter", p[0].line, p[0].text)
		}
		param := p[0].text
		annotation, value, hasDefault := splitParam(p[1:])
		if !keywordOnly && !hasDefault {
			if len(fn.Settings) > 0 {
				return nil, fmt.Errorf("line %d: input %s comes after a setting; inputs come first", p[0].line, param)
			}
			fn.Inputs = append(fn.Inputs, param)
			continue
		}
		if param == bySetting {
			return nil, fmt.Errorf("line %d: %s is the setting that groups an operator's rows; name yours otherwise", p[0].line, bySetting)
		}
		s, err := pySettingOf(param, annotation, value, hasDefault)
		if err != nil {
			return nil, fmt.Errorf("line %d: setting %s: %w", p[0].line, param, err)
		}
		fn.Settings = append(fn.Settings, s)
	}
	if len(fn.Inputs) == 0 {
		return nil, fmt.Errorf("%s reads no table: its first parameters are its inputs, as def %s(readings, *, ...)", name, name)
	}

	// The docstring: the body's first statement, when it is a string alone.
	if at+1 < len(lines) && lines[at+1].col > 0 && len(lines[at+1].tokens) == 1 && lines[at+1].tokens[0].kind == "string" {
		fn.Doc = docstring(lines[at+1].tokens[0].text)
	}
	return fn, nil
}

// splitTop splits tokens at the commas outside brackets, up to the bracket that closes them.
func splitTop(tokens []pyToken, closing string) ([][]pyToken, error) {
	var out [][]pyToken
	var cur []pyToken
	depth := 0
	for _, t := range tokens {
		if t.kind == "op" {
			switch t.text {
			case "(", "[", "{":
				depth++
			case ")", "]", "}":
				if depth == 0 {
					if t.text != closing {
						return nil, fmt.Errorf("%q does not close what was opened", t.text)
					}
					return append(out, cur), nil
				}
				depth--
			case ",":
				if depth == 0 {
					out = append(out, cur)
					cur = nil
					continue
				}
			}
		}
		cur = append(cur, t)
	}
	return nil, fmt.Errorf("%q is missing", closing)
}

// splitParam reads `: annotation = default` after a parameter's name.
func splitParam(rest []pyToken) (annotation, value []pyToken, hasDefault bool) {
	depth := 0
	if len(rest) > 0 && rest[0].text == ":" {
		rest = rest[1:]
		for i, t := range rest {
			switch t.text {
			case "(", "[", "{":
				depth++
			case ")", "]", "}":
				depth--
			case "=":
				if depth == 0 {
					return rest[:i], rest[i+1:], true
				}
			}
		}
		return rest, nil, false
	}
	if len(rest) > 0 && rest[0].text == "=" {
		return nil, rest[1:], true
	}
	return nil, nil, false
}

// pyColumnTypes are the types @returns may name, by their Python and their Texera names.
var pyColumnTypes = map[string]string{
	"str": "string", "string": "string", "text": "string",
	"int": "long", "integer": "integer", "long": "long",
	"float": "double", "double": "double",
	"bool": "boolean", "boolean": "boolean",
	"datetime": "timestamp", "datetime.datetime": "timestamp", "Timestamp": "timestamp", "pd.Timestamp": "timestamp", "pandas.Timestamp": "timestamp", "timestamp": "timestamp",
}

// readReturns reads `name=type, ...)` of @returns, the columns in order, and its
// nondeterministic=True or False.
func (fn *pyFunction) readReturns(tokens []pyToken) error {
	parts, err := splitTop(tokens, ")")
	if err != nil {
		return err
	}
	var out []api.Attribute
	seen := map[string]bool{}
	for _, p := range parts {
		if len(p) == 0 {
			continue
		}
		if len(p) < 3 || p[0].kind != "name" || p[1].text != "=" {
			return fmt.Errorf("@returns names each column as name=type, as @returns(patient_id=str, mean=float)")
		}
		if p[0].text == "nondeterministic" {
			if len(p) != 3 || (p[2].text != "True" && p[2].text != "False") {
				return fmt.Errorf("@returns takes nondeterministic=True or nondeterministic=False")
			}
			fn.Nondeterministic = p[2].text == "True"
			continue
		}
		var typ string
		if p[2].kind == "string" && len(p) == 3 {
			typ = p[2].text
		} else {
			var sb strings.Builder
			for _, t := range p[2:] {
				sb.WriteString(t.text)
			}
			typ = sb.String()
		}
		t, ok := pyColumnTypes[typ]
		if !ok {
			return fmt.Errorf("column %s: %q is not a column type; use str, int, float, bool or datetime", p[0].text, typ)
		}
		if seen[p[0].text] {
			return fmt.Errorf("column %s is named twice", p[0].text)
		}
		seen[p[0].text] = true
		out = append(out, api.Attribute{AttributeName: p[0].text, AttributeType: t})
	}
	if len(out) == 0 {
		return fmt.Errorf("@returns names no column; %s's output needs at least one", fn.Name)
	}
	fn.Returns = out
	return nil
}

// pySettingOf is a setting's JSON Schema property: its type from its annotation, else from its
// default, and its default.
func pySettingOf(name string, annotation, value []pyToken, hasDefault bool) (pySetting, error) {
	schema := map[string]any{}
	if t := schemaOfAnnotation(annotation); t != nil {
		schema = t
	}
	if hasDefault {
		v, rest, err := pyLiteral(value)
		if err != nil || len(rest) > 0 {
			return pySetting{}, fmt.Errorf("its default must be a number, text, True, False, None or a list of them")
		}
		if _, ok := schema["type"]; !ok {
			schema = schemaOfValue(v)
		}
		if v != nil {
			schema["default"] = v
		}
	}
	if _, ok := schema["type"]; !ok {
		return pySetting{}, fmt.Errorf("say its type, as %s: int = 0", name)
	}
	return pySetting{Name: name, Schema: schema, Required: !hasDefault}, nil
}

func schemaOfAnnotation(tokens []pyToken) map[string]any {
	var parts []string
	for _, t := range tokens {
		parts = append(parts, t.text)
	}
	text := strings.Join(parts, "")
	// Optional[X], X | None and Union[X, None] say a setting may be left empty: X is its type.
	if strings.HasPrefix(text, "Optional[") && strings.HasSuffix(text, "]") {
		text = strings.TrimSuffix(strings.TrimPrefix(text, "Optional["), "]")
	}
	text = strings.TrimSuffix(text, "|None")
	text = strings.TrimPrefix(text, "None|")
	if strings.HasPrefix(text, "Union[") && strings.HasSuffix(text, ",None]") {
		text = strings.TrimSuffix(strings.TrimPrefix(text, "Union["), ",None]")
	}
	scalar := map[string]string{"int": "integer", "float": "number", "str": "string", "bool": "boolean"}
	if t, ok := scalar[text]; ok {
		return map[string]any{"type": t}
	}
	for _, list := range []string{"list", "List", "tuple", "Tuple", "Sequence", "typing.List"} {
		if text == list {
			return map[string]any{"type": "array"}
		}
		if strings.HasPrefix(text, list+"[") && strings.HasSuffix(text, "]") {
			item := strings.TrimSuffix(strings.TrimPrefix(text, list+"["), "]")
			item = strings.TrimSuffix(item, ",...")
			if t, ok := scalar[item]; ok {
				return map[string]any{"type": "array", "items": map[string]any{"type": t}}
			}
			return map[string]any{"type": "array"}
		}
	}
	return nil
}

func schemaOfValue(v any) map[string]any {
	switch x := v.(type) {
	case bool:
		return map[string]any{"type": "boolean"}
	case int64:
		return map[string]any{"type": "integer"}
	case float64:
		return map[string]any{"type": "number"}
	case string:
		return map[string]any{"type": "string"}
	case []any:
		if len(x) > 0 {
			return map[string]any{"type": "array", "items": schemaOfValue(x[0])}
		}
		return map[string]any{"type": "array"}
	}
	return map[string]any{}
}

// pyLiteral reads a literal from tokens: a number, a string, True, False, None, or a list or
// tuple of them. It returns what is left after it.
func pyLiteral(tokens []pyToken) (any, []pyToken, error) {
	if len(tokens) == 0 {
		return nil, nil, fmt.Errorf("no value")
	}
	t := tokens[0]
	switch {
	case t.kind == "op" && t.text == "-" && len(tokens) > 1 && tokens[1].kind == "number":
		v, rest, err := pyLiteral(tokens[1:])
		if err != nil {
			return nil, nil, err
		}
		switch n := v.(type) {
		case int64:
			return -n, rest, nil
		case float64:
			return -n, rest, nil
		}
		return nil, nil, fmt.Errorf("not a number")
	case t.kind == "number":
		text := strings.ReplaceAll(t.text, "_", "")
		if n, err := strconv.ParseInt(text, 0, 64); err == nil {
			return n, tokens[1:], nil
		}
		f, err := strconv.ParseFloat(text, 64)
		if err != nil {
			return nil, nil, err
		}
		return f, tokens[1:], nil
	case t.kind == "string":
		// Adjacent strings join, as in Python.
		s, rest := t.text, tokens[1:]
		for len(rest) > 0 && rest[0].kind == "string" {
			s += rest[0].text
			rest = rest[1:]
		}
		return s, rest, nil
	case t.kind == "name" && t.text == "True":
		return true, tokens[1:], nil
	case t.kind == "name" && t.text == "False":
		return false, tokens[1:], nil
	case t.kind == "name" && t.text == "None":
		return nil, tokens[1:], nil
	case t.kind == "op" && (t.text == "[" || t.text == "("):
		closing := map[string]string{"[": "]", "(": ")"}[t.text]
		list := []any{}
		rest := tokens[1:]
		for {
			if len(rest) > 0 && rest[0].text == closing {
				return list, rest[1:], nil
			}
			v, after, err := pyLiteral(rest)
			if err != nil {
				return nil, nil, err
			}
			list = append(list, v)
			rest = after
			if len(rest) > 0 && rest[0].text == "," {
				rest = rest[1:]
				continue
			}
			if len(rest) > 0 && rest[0].text == closing {
				return list, rest[1:], nil
			}
			return nil, nil, fmt.Errorf("expected , or %s", closing)
		}
	}
	return nil, nil, fmt.Errorf("%q is not a literal", t.text)
}

// docstring trims a docstring's indentation and its blank first and last lines.
func docstring(s string) string {
	lines := strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n")
	indent := -1
	for _, l := range lines[1:] {
		if strings.TrimSpace(l) == "" {
			continue
		}
		n := len(l) - len(strings.TrimLeft(l, " \t"))
		if indent < 0 || n < indent {
			indent = n
		}
	}
	for i := 1; i < len(lines); i++ {
		if indent > 0 && len(lines[i]) >= indent {
			lines[i] = lines[i][indent:]
		}
	}
	lines[0] = strings.TrimSpace(lines[0])
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

// functionOperator fills a function operator's spec from its code: its ports, its settings,
// its output columns, whether it is nondeterministic and, unless it has one, its description.
func functionOperator(doc map[string]any) error {
	impl, _ := doc["implementation"].(map[string]any)
	py, _ := impl["python"].(map[string]any)
	name, _ := py["function"].(string)
	if py == nil || strings.TrimSpace(name) == "" {
		return nil
	}
	code, _ := py["code"].(string)
	fn, err := parsePyFunction(code, name)
	if err != nil {
		return err
	}
	if t, _ := doc["operatorType"].(string); strings.TrimSpace(t) == "" {
		doc["operatorType"] = name
	}
	if d, _ := doc["description"].(string); strings.TrimSpace(d) == "" && fn.Doc != "" {
		doc["description"] = fn.Doc
	}
	inputs := make([]any, len(fn.Inputs))
	for i, input := range fn.Inputs {
		port := map[string]any{"portID": fmt.Sprintf("input-%d", i)}
		if len(fn.Inputs) > 1 {
			port["displayName"] = input
		}
		inputs[i] = port
	}
	doc["inputPorts"] = inputs
	doc["outputPorts"] = []any{map[string]any{"portID": "output-0"}}
	properties := map[string]any{
		bySetting: map[string]any{
			"type":        "array",
			"items":       map[string]any{"type": "string"},
			"description": "The columns whose rows reach one call together: each group whole on one worker. Absent: one worker gets every row.",
		},
	}
	var required []any
	for i, s := range fn.Settings {
		s.Schema["propertyOrder"] = i + 1
		properties[s.Name] = s.Schema
		if s.Required {
			required = append(required, s.Name)
		}
	}
	schema := map[string]any{"type": "object", "properties": properties}
	if len(required) > 0 {
		schema["required"] = required
	}
	doc["propertiesSchema"] = schema
	columns := make([]any, len(fn.Returns))
	for i, a := range fn.Returns {
		columns[i] = map[string]any{"attributeName": a.AttributeName, "attributeType": a.AttributeType}
	}
	py["outputColumns"] = columns
	// What the code says, whatever the request said.
	if fn.Nondeterministic {
		py["nondeterministic"] = true
	} else {
		delete(py, "nondeterministic")
	}
	return nil
}
