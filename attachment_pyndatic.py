import ast
import json
import os
import re
from io import BytesIO
from typing import Any, Dict, Optional

import pandas as pd
from pydantic import BaseModel, Field

from logger.privatai_logger import PrivateAILogger


logger = PrivateAILogger().get_logger()

MAX_SCHEMA_SAMPLE_ROWS = 3


# ============================================================
# Pydantic model
# ============================================================

class AttachmentPandasOperation(BaseModel):
    operation_required: bool = Field(
        ...,
        description="Whether the user asked to transform the email attachment data",
    )

    code: str = Field(
        ...,
        description="Safe pandas code that assigns transformed attachment rows to result",
    )

    explanation: str = Field(
        ...,
        description="Short explanation of the operation",
    )

    split_sheet_by: Optional[str] = Field(
        None,
        description="Column to split into separate Excel sheets, or null",
    )

    split_workbook_by: Optional[str] = Field(
        None,
        description=(
            "Column to split into separate Excel workbook files/attachments, "
            "or null"
        ),
    )

    sort_sheet_by: Optional[str] = Field(
        None,
        description=(
            "Column used to sort every generated Excel sheet, "
            "including original_data, or null"
        ),
    )

    sort_order: Optional[str] = Field(
        None,
        description="Sort direction for sort_sheet_by: asc or desc",
    )

    color_code_column: Optional[str] = Field(
        None,
        description="Column used for user-requested Excel color coding, or null",
    )

    color_code_operator: Optional[str] = Field(
        None,
        description="Comparison operator for color coding: >, >=, <, <=, ==",
    )

    color_code_threshold: Optional[float] = Field(
        None,
        description="Numeric threshold for color coding",
    )

    color_code_hex: Optional[str] = Field(
        None,
        description="Excel fill color for matching rows, such as #0000FF for blue",
    )

    output_filename: Optional[str] = Field(
        None,
        description="Suggested .xlsx filename for the transformed attachment",
    )


class UnsafeAttachmentPandasCode(ValueError):
    pass


# ============================================================
# Logging helpers
# ============================================================

def _truncate_log_value(value: Any, limit: int = 600) -> str:
    text = str(value)
    return text if len(text) <= limit else f"{text[:limit]}...<truncated>"


def _dataframe_log_summary(df: pd.DataFrame) -> Dict[str, Any]:
    if df is None:
        return {"is_none": True}

    return {
        "rows": int(len(df)),
        "columns_count": int(len(df.columns)),
        "columns": list(df.columns),
        "dtypes": {
            column: str(dtype)
            for column, dtype in df.dtypes.items()
        },
    }


# ============================================================
# Numeric helpers
# ============================================================

def _coerce_numeric_like_columns(df: pd.DataFrame) -> pd.DataFrame:
    coerced_df = df.copy()
    converted_columns = []

    for column in coerced_df.columns:
        series = coerced_df[column]

        if pd.api.types.is_numeric_dtype(series):
            continue

        cleaned = (
            series.astype(str)
            .str.replace(r"[$,]", "", regex=True)
            .str.strip()
        )

        numeric = pd.to_numeric(
            cleaned,
            errors="coerce",
        )

        non_empty = (
            cleaned.ne("")
            & cleaned.str.lower().ne("nan")
        )

        if int(non_empty.sum()) > 0:
            if numeric[non_empty].notna().mean() >= 0.8:
                coerced_df[column] = numeric
                converted_columns.append(column)

    if converted_columns:
        logger.info(
            "attachment_pydantic: coerced numeric-like columns "
            "before generated pandas code: %s",
            converted_columns,
        )

    return coerced_df


def _coerce_report_numeric(series: pd.Series) -> pd.Series:
    """
    Converts values such as:

        1000000
        1,000,000
        $1,000,000
        ₹1,000,000

    into numeric values.
    """

    cleaned = (
        series.astype(str)
        .str.replace(r"[$,₹]", "", regex=True)
        .str.strip()
    )

    return pd.to_numeric(
        cleaned,
        errors="coerce",
    )


# ============================================================
# Schema / prompt helpers
# ============================================================

def _schema_for_prompt(df: pd.DataFrame) -> Dict[str, Any]:
    sample_df = df.head(MAX_SCHEMA_SAMPLE_ROWS)

    sample = sample_df.where(
        pd.notna(sample_df),
        None,
    )

    return {
        "total_rows": int(len(df)),
        "columns": list(df.columns),
        "dtypes": {
            column: str(dtype)
            for column, dtype in df.dtypes.items()
        },
        "sample_data": sample.to_dict(
            orient="records"
        ),
    }


def _strip_json_markdown(content: str) -> str:
    content = content.strip()

    if content.startswith("```json"):
        return (
            content
            .split("```json", 1)[1]
            .split("```", 1)[0]
            .strip()
        )

    if content.startswith("```"):
        return (
            content
            .split("```", 1)[1]
            .split("```", 1)[0]
            .strip()
        )

    return content


def _build_attachment_operation_prompt(
    query: str,
    df: pd.DataFrame,
    datamart_context: Any = "",
) -> str:

    context_text = (
        datamart_context
        if isinstance(datamart_context, str)
        else json.dumps(
            datamart_context,
            default=str,
        )
    )

    return f"""
You are planning pandas operations for an EMAIL ATTACHMENT only.

The incoming attachment data is available as a pandas DataFrame named `df`.

DataFrame information:
{json.dumps(_schema_for_prompt(df), indent=2, default=str)}

Context:
{context_text}

User request:
{query}

Decide whether the attachment must be transformed before sending.

Attachment transformations include:
- group by seller/vendor/customer/product/status/etc.
- filter rows
- sort rows
- aggregate totals/counts/averages
- select or reorder columns
- split the Excel workbook into multiple sheets/tabs by a column
- split the result into multiple Excel workbook files/attachments by a column
- sort every generated Excel sheet/tab, including original_data

If the user only asks to send the attachment as-is,
set operation_required=false.

If the user asks only to split data into sheets, tabs, or workbooks
without changing rows or columns, set operation_required=true and use:
result = df.copy()

============================================================
RULES FOR GENERATED PANDAS CODE
============================================================

- Use the existing DataFrame variable `df`.
- Always assign the transformed attachment rows to `result`.
- Return `result` as a pandas DataFrame.
- Use only pandas operations.
- Prefer:
  groupby, agg, sum, mean, count, nunique,
  sort_values, pivot_table, query, unique.
- Convert numeric-looking amount/count/day columns with
  pd.to_numeric before comparing/filtering/sorting when needed.
- Do not read or write files.
- Do not use lambda.
- Do not define functions.
- Do not use loops.
- Do not use list/dict/set comprehensions.
- Do not use eval or exec.

============================================================
SPECIAL RECEIVABLES / PAYABLES RULE
============================================================

If the user asks for a receivables/payables workflow involving:
- overdue invoices
- days_overdue
- invoices
- amount
- not yet due
- due dates
- overdue sorting

DO NOT implement the final special Excel sorting in the pandas code.

The deterministic Excel writer will perform the final sorting.

For this workflow, the pandas code should only perform
data transformations required by the user's request.

The deterministic Excel writer will sort each sheet as follows:

1. OVERDUE invoices:
   days_overdue > 0

   These rows must come FIRST.

   Sort:
       Amount DESC
       days_overdue DESC as tie-breaker

2. NOT-YET-DUE invoices:
   days_overdue <= 0

   These rows come AFTER overdue invoices.

   Sort:
       days_overdue DESC
       Amount DESC as tie-breaker

Example:

days_overdue | Amount
-------------|--------
30           | 500000
10           | 900000
5            | 1000000
-1           | 800000
-3           | 900000
-10          | 1000000

Expected order:

1000000 | 5
900000  | 10
500000  | 30
800000  | -1
900000  | -3
1000000 | -10

This special ordering is applied independently to:
- every Buyer sheet
- original_data

============================================================
RULES FOR SPLIT SHEETS
============================================================

- Do not create sheets in pandas code.
- If the user asks for separate sheets/tabs by a column,
  put that existing column name in `split_sheet_by`.
- If the user asks for separate workbook files, separate Excel files,
  separate attachments, or one workbook/file per seller/vendor/customer/etc.,
  do NOT use `split_sheet_by`; use `split_workbook_by` instead.
- The deterministic attachment writer will create workbook
  tabs after the pandas code runs.
- If no split is requested, use null for split_sheet_by.

============================================================
RULES FOR SPLIT WORKBOOK FILES / ATTACHMENTS
============================================================

- Do not create workbooks or files in pandas code.
- If the user asks to split into separate workbooks/files/attachments,
  one Excel file per seller/vendor/customer/status/etc.,
  put that existing column name in `split_workbook_by`.
- If the user says "Split the workbook into separate by Buyer"
  or "split workbook separate by <column>", treat it as
  multiple workbook files and put that column in `split_workbook_by`.
- The deterministic attachment writer will create multiple .xlsx
  attachments after the pandas code runs.
- If split_workbook_by is set, keep split_sheet_by null unless the
  user explicitly asks for sheets inside each separate workbook.
- If the user says "split into workbook" or "separate workbooks",
  this means multiple workbook files, not multiple sheets.
- If no separate workbook files are requested, use null for split_workbook_by.

============================================================
RULES FOR GENERIC SHEET SORTING
============================================================

For NON-receivables/payables requests:

- If the user asks to sort split sheets/tabs or original_data
  by a column, put that existing column name in `sort_sheet_by`.
- Put sort_order as "asc" or "desc".
- If the user asks for amount highest-to-lowest,
  biggest-to-smallest, descending, or desc, use "desc".
- For the special receivables/payables workflow,
  use null for sort_sheet_by and sort_order.

============================================================
RULES FOR COLOR CODING
============================================================

If the user asks to color code rows/cells by a column:

- fill color_code_column
- fill color_code_operator
- fill color_code_threshold
- fill color_code_hex

Use the exact existing dataframe column name.

If user says:
- more than / greater than / above -> >
- at least / greater than or equal -> >=
- less than / below -> <
- less than or equal -> <=

Convert:
- 1k -> 1000
- 1m -> 1000000

Colors:
- blue = #0000FF
- red = #FF0000
- green = #00B050
- yellow = #FFFF00
- pink = #F4CCCC
- nude = #FCE4D6

For the special receivables/payables workflow,
the deterministic Excel writer automatically applies:

Amount >= 1000000 -> pink
Amount < 1000000 -> nude

============================================================
RETURN FORMAT
============================================================

Return only valid JSON in this exact shape:

{{
  "operation_required": true,
  "code": "pandas code here",
  "explanation": "short explanation",
  "split_sheet_by": null,
  "split_workbook_by": null,
  "sort_sheet_by": null,
  "sort_order": null,
  "color_code_column": null,
  "color_code_operator": null,
  "color_code_threshold": null,
  "color_code_hex": null,
  "output_filename": "processed_attachment.xlsx"
}}
""".strip()


# ============================================================
# Pandas code validation
# ============================================================

def _validate_pandas_code(code: str) -> None:
    tree = ast.parse(
        code,
        mode="exec",
    )

    blocked_nodes = (
        ast.Import,
        ast.ImportFrom,
        ast.With,
        ast.AsyncWith,
        ast.FunctionDef,
        ast.AsyncFunctionDef,
        ast.ClassDef,
        ast.Lambda,
        ast.Try,
        ast.While,
        ast.For,
        ast.AsyncFor,
        ast.Delete,
        ast.Global,
        ast.Nonlocal,
        ast.Raise,
    )

    blocked_calls = {
        "eval",
        "exec",
        "compile",
        "open",
        "__import__",
        "input",
        "globals",
        "locals",
        "vars",
        "dir",
        "getattr",
        "setattr",
        "delattr",
    }

    blocked_attributes = {
        "read_csv",
        "read_excel",
        "read_json",
        "read_parquet",
        "to_csv",
        "to_excel",
        "to_json",
        "to_parquet",
        "to_pickle",
        "to_sql",
        "to_feather",
        "to_hdf",
        "to_stata",
    }

    for node in ast.walk(tree):

        if isinstance(node, blocked_nodes):
            raise UnsafeAttachmentPandasCode(
                f"Disallowed Python construct: "
                f"{type(node).__name__}"
            )

        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in blocked_calls
        ):
            raise UnsafeAttachmentPandasCode(
                f"Disallowed function call: {node.func.id}"
            )

        if (
            isinstance(node, ast.Attribute)
            and node.attr.startswith("__")
        ):
            raise UnsafeAttachmentPandasCode(
                "Dunder attribute access is not allowed"
            )

        if (
            isinstance(node, ast.Attribute)
            and node.attr in blocked_attributes
        ):
            raise UnsafeAttachmentPandasCode(
                f"Disallowed pandas/file method: {node.attr}"
            )

    assigned_names = {
        target.id
        for node in ast.walk(tree)
        if isinstance(node, ast.Assign)
        for target in node.targets
        if isinstance(target, ast.Name)
    }

    if "result" not in assigned_names:
        raise UnsafeAttachmentPandasCode(
            "Generated code must assign final output to `result`"
        )


def _normalize_generated_code(code: str) -> str:
    normalized_lines = []

    for line in str(code or "").splitlines():
        stripped = line.strip()

        if stripped in {
            "import pandas as pd",
            "import pandas",
        }:
            continue

        normalized_lines.append(line)

    return "\n".join(
        normalized_lines
    ).strip()


def _execute_pandas_code(
    code: str,
    df: pd.DataFrame,
) -> Any:

    code = _normalize_generated_code(code)

    logger.info(
        "attachment_pydantic: executing generated pandas code=%s",
        code,
    )

    _validate_pandas_code(code)

    safe_globals = {
        "__builtins__": {
            "len": len,
            "min": min,
            "max": max,
            "sum": sum,
            "round": round,
            "str": str,
            "int": int,
            "float": float,
        }
    }

    local_vars = {
        "df": df.copy(),
        "pd": pd,
    }

    try:
        exec(
            code,
            safe_globals,
            local_vars,
        )

        return local_vars.get("result")

    except TypeError as exc:

        if (
            "not supported between instances"
            not in str(exc)
        ):
            raise

        logger.warning(
            "attachment_pydantic: generated code failed "
            "on original dataframe due to mixed "
            "string/numeric comparison; retrying with "
            "numeric-like columns coerced: %s",
            exc,
        )

    coerced_local_vars = {
        "df": _coerce_numeric_like_columns(df),
        "pd": pd,
    }

    exec(
        code,
        safe_globals,
        coerced_local_vars,
    )

    return coerced_local_vars.get("result")


# ============================================================
# Excel helpers
# ============================================================

def _safe_excel_sheet_name(
    value: Any,
    used_names: set[str],
) -> str:

    if value is None or (
        not isinstance(value, str)
        and pd.isna(value)
    ):
        value = "Blank"

    name = re.sub(
        r"[\[\]\:\*\?\/\\]+",
        "_",
        str(value),
    ).strip()

    name = re.sub(
        r"\s+",
        " ",
        name,
    )[:31].strip() or "Blank"

    base = name
    counter = 1

    while name in used_names:

        suffix = f"_{counter}"

        name = (
            f"{base[:31 - len(suffix)]}"
            f"{suffix}"
        )

        counter += 1

    used_names.add(name)

    return name


def _excel_col_name(index: int) -> str:
    name = ""
    index += 1

    while index:
        index, remainder = divmod(
            index - 1,
            26,
        )

        name = (
            chr(65 + remainder)
            + name
        )

    return name


def _normalized_column_name(
    column: Any,
) -> str:

    return re.sub(
        r"[^a-z0-9]+",
        "",
        str(column or "").strip().lower(),
    )


def _find_report_column(
    df: pd.DataFrame,
    candidates: set[str],
) -> Optional[str]:

    for column in df.columns:

        if (
            _normalized_column_name(column)
            in candidates
        ):
            return column

    return None


def _find_report_columns(
    df: pd.DataFrame,
    candidates: set[str],
) -> list[str]:

    return [
        column
        for column in df.columns
        if _normalized_column_name(column) in candidates
    ]


def _resolve_dataframe_column(
    df: pd.DataFrame,
    requested_column: Optional[str],
) -> Optional[str]:

    if not requested_column:
        return None

    requested_normalized = (
        _normalized_column_name(
            requested_column
        )
    )

    # Exact match first
    for column in df.columns:

        if str(column) == str(requested_column):
            return column

    # Normalized match
    for column in df.columns:

        if (
            _normalized_column_name(column)
            == requested_normalized
        ):
            return column

    return None


def _looks_like_separate_workbook_split_request(
    query: str,
) -> bool:
    text = str(query or "").lower()

    has_workbook_target = any(
        term in text
        for term in {
            "workbook",
            "workbooks",
            "excel",
            "excels",
            "file",
            "files",
            "attachment",
            "attachments",
        }
    )

    has_separate_intent = any(
        term in text
        for term in {
            "split the workbook",
            "split workbook",
            "split into workbook",
            "split into workbooks",
            "separate workbook",
            "separate workbooks",
            "seperate workbook",
            "seperate workbooks",
            "separate excel",
            "separate excels",
            "seperate excel",
            "seperate excels",
            "separate file",
            "separate files",
            "seperate file",
            "seperate files",
            "one workbook per",
            "one excel per",
            "one file per",
        }
    )

    sheet_or_tab_split_intent = any(
        term in text
        for term in {
            "split sheet",
            "split sheets",
            "split tab",
            "split tabs",
            "split into sheet",
            "split into sheets",
            "split into tab",
            "split into tabs",
            "separate sheet",
            "separate sheets",
            "separate tab",
            "separate tabs",
            "one sheet per",
            "one tab per",
        }
    )

    return (
        has_workbook_target
        and has_separate_intent
        and not sheet_or_tab_split_intent
    )


# ============================================================
# Generic sheet sorting
# ============================================================

def _sort_sheet_by_column(
    df: pd.DataFrame,
    requested_column: Optional[str],
    sort_order: Optional[str],
) -> pd.DataFrame:

    sort_col = _resolve_dataframe_column(
        df,
        requested_column,
    )

    if not sort_col:

        logger.warning(
            "attachment_pydantic: sheet sort skipped "
            "requested_column=%s columns=%s",
            requested_column,
            list(df.columns),
        )

        return df

    ascending = (
        str(sort_order or "asc")
        .strip()
        .lower()
        not in {
            "desc",
            "descending",
            "highest",
            "largest",
            "biggest",
        }
    )

    sortable_df = df.copy()

    sort_values = _coerce_report_numeric(
        sortable_df[sort_col]
    )

    if sort_values.notna().any():

        sort_key = "_attachment_sheet_sort_key"

        sortable_df[sort_key] = sort_values

    else:
        sort_key = sort_col

    logger.info(
        "attachment_pydantic: applying generic "
        "sheet sort column=%s order=%s "
        "ascending=%s rows=%d",
        sort_col,
        sort_order,
        ascending,
        len(sortable_df),
    )

    return (
        sortable_df
        .sort_values(
            by=sort_key,
            ascending=ascending,
            na_position="last",
            kind="mergesort",
        )
        .drop(
            columns=[
                "_attachment_sheet_sort_key"
            ],
            errors="ignore",
        )
    )


# ============================================================
# RECEIVABLES / PAYABLES SORTING
# ============================================================

def _sort_receivables_payables_sheet_old(
    df: pd.DataFrame,
) -> pd.DataFrame:

    days_col = _find_report_column(
        df,
        {
            "daysoverdue",
            "overduedays",
            "daysdue",
            "duedays",
            "agingdays",
            "age",
        },
    )

    amount_col = _find_report_column(
        df,
        {
            "invoiceamount",
            "invoiceamt",
            "amount",
            "invoicevalue",
            "totalinvoiceamount",
            "balance",
            "outstandingamount",
            "dueamount",
            "invamt",
            "amt",
        },
    )

    if not days_col or not amount_col:

        logger.warning(
            "attachment_pydantic: receivables/payables "
            "sort skipped days_col=%s amount_col=%s "
            "columns=%s",
            days_col,
            amount_col,
            list(df.columns),
        )

        return df

    logger.info(
        "attachment_pydantic: applying receivables/payables "
        "sort days_col=%s amount_col=%s rows=%d",
        days_col,
        amount_col,
        len(df),
    )

    sortable_df = df.copy()

    sortable_df[
        "_report_days_overdue_sort"
    ] = _coerce_report_numeric(
        sortable_df[days_col]
    )

    sortable_df[
        "_report_amount_sort"
    ] = _coerce_report_numeric(
        sortable_df[amount_col]
    )

    # --------------------------------------------------------
    # FIRST:
    # days_overdue > 0
    #
    # Sort Amount DESC
    # Tie-breaker days_overdue DESC
    # --------------------------------------------------------

    overdue_df = (
        sortable_df[
            sortable_df[
                "_report_days_overdue_sort"
            ] > 0
        ]
        .sort_values(
            by=[
                "_report_amount_sort",
                "_report_days_overdue_sort",
            ],
            ascending=[
                False,
                False,
            ],
            na_position="last",
            kind="mergesort",
        )
    )

    # --------------------------------------------------------
    # SECOND:
    # days_overdue <= 0
    #
    # Sort days_overdue DESC
    # Tie-breaker Amount DESC
    #
    # Example:
    # -1 before -5 before -10
    # --------------------------------------------------------

    not_due_df = (
        sortable_df[
            sortable_df[
                "_report_days_overdue_sort"
            ].le(0)
            |
            sortable_df[
                "_report_days_overdue_sort"
            ].isna()
        ]
        .sort_values(
            by=[
                "_report_days_overdue_sort",
                "_report_amount_sort",
            ],
            ascending=[
                False,
                False,
            ],
            na_position="last",
            kind="mergesort",
        )
    )

    result = pd.concat(
        [
            overdue_df,
            not_due_df,
        ],
        ignore_index=True,
    )

    return result.drop(
        columns=[
            "_report_days_overdue_sort",
            "_report_amount_sort",
        ],
        errors="ignore",
    )



def _sort_receivables_payables_sheet(
    df: pd.DataFrame,
) -> pd.DataFrame:

    days_col = _find_report_column(
        df,
        {
            "daysoverdue",
            "overduedays",
            "daysdue",
            "duedays",
            "agingdays",
            "age",
        },
    )

    amount_col = _find_report_column(
        df,
        {
            "invoiceamount",
            "invoiceamt",
            "amount",
            "invoicevalue",
            "totalinvoiceamount",
            "balance",
            "outstandingamount",
            "dueamount",
            "invamt",
            "amt",
        },
    )

    if not days_col or not amount_col:
        logger.warning(
            "attachment_pydantic: receivables/payables "
            "sort skipped days_col=%s amount_col=%s columns=%s",
            days_col,
            amount_col,
            list(df.columns),
        )
        return df

    sortable_df = df.copy()

    sortable_df[
        "_report_days_overdue_sort"
    ] = _coerce_report_numeric(
        sortable_df[days_col]
    )

    sortable_df[
        "_report_amount_sort"
    ] = _coerce_report_numeric(
        sortable_df[amount_col]
    )

    # ========================================================
    # 1. OVERDUE
    #
    # days_overdue > 0
    # Amount DESC
    # days_overdue DESC as tie breaker
    # ========================================================

    overdue_df = (
        sortable_df[
            sortable_df[
                "_report_days_overdue_sort"
            ] > 0
        ]
        .sort_values(
            by=[
                "_report_amount_sort",
                "_report_days_overdue_sort",
            ],
            ascending=[
                False,
                False,
            ],
            na_position="last",
            kind="mergesort",
        )
    )

    # ========================================================
    # 2. NOT YET DUE
    #
    # days_overdue <= 0
    # days_overdue DESC
    # Amount DESC as tie breaker
    # ========================================================

    not_due_df = (
        sortable_df[
            sortable_df[
                "_report_days_overdue_sort"
            ].le(0)
            |
            sortable_df[
                "_report_days_overdue_sort"
            ].isna()
        ]
        .sort_values(
            by=[
                "_report_days_overdue_sort",
                "_report_amount_sort",
            ],
            ascending=[
                False,
                False,
            ],
            na_position="last",
            kind="mergesort",
        )
    )

    result = pd.concat(
        [
            overdue_df,
            not_due_df,
        ],
        ignore_index=True,
    )

    return result.drop(
        columns=[
            "_report_days_overdue_sort",
            "_report_amount_sort",
        ],
        errors="ignore",
    )

# ============================================================
# Receivable workflow detection
# ============================================================

def _is_receivables_payables_workflow(
    query: str,
    df: pd.DataFrame,
) -> bool:

    query_lower = str(
        query or ""
    ).lower()

    workflow_keywords = [
        "receivable",
        "receivables",
        "payable",
        "payables",
        "invoice",
        "invoices",
        "overdue",
        "days_overdue",
        "days overdue",
        "not yet due",
        "due dates",
        "due date",
    ]

    keyword_match = any(
        keyword in query_lower
        for keyword in workflow_keywords
    )

    days_col = _find_report_column(
        df,
        {
            "daysoverdue",
            "overduedays",
            "daysdue",
            "duedays",
            "agingdays",
            "age",
        },
    )

    amount_col = _find_report_column(
        df,
        {
            "invoiceamount",
            "invoiceamt",
            "amount",
            "invoicevalue",
            "totalinvoiceamount",
            "balance",
            "outstandingamount",
            "dueamount",
            "invamt",
            "amt",
        },
    )

    detected = (
        keyword_match
        and days_col is not None
        and amount_col is not None
    )

    logger.info(
        "attachment_pydantic: receivables/payables "
        "workflow detection=%s keyword_match=%s "
        "days_col=%s amount_col=%s",
        detected,
        keyword_match,
        days_col,
        amount_col,
    )

    return detected


# ============================================================
# Excel color helpers
# ============================================================

def _normalize_excel_color(
    value: Optional[str],
) -> Optional[str]:

    if not value:
        return None

    normalized = (
        str(value)
        .strip()
        .lower()
        .replace(" ", "")
    )

    color_map = {
        "blue": "#0000FF",
        "red": "#FF0000",
        "green": "#00B050",
        "yellow": "#FFFF00",
        "pink": "#F4CCCC",
        "nude": "#FCE4D6",
    }

    color = color_map.get(
        normalized,
        str(value).strip(),
    )

    if re.fullmatch(
        r"#?[0-9A-Fa-f]{6}",
        color,
    ):
        return color.replace(
            "#",
            "",
        ).upper()

    return None


def _comparison_formula(
    cell_reference: str,
    operator: Optional[str],
    threshold: Optional[float],
) -> Optional[str]:

    if threshold is None:
        return None

    normalized_operator = (
        str(operator or ">")
        .strip()
        .lower()
    )

    operator_map = {
        "greaterthan": ">",
        "morethan": ">",
        "above": ">",
        "gt": ">",
        "greaterthanequal": ">=",
        "atleast": ">=",
        "gte": ">=",
        "lessthan": "<",
        "below": "<",
        "lt": "<",
        "lessthanequal": "<=",
        "lte": "<=",
        "equal": "=",
        "equals": "=",
        "==": "=",
    }

    operator_value = operator_map.get(
        normalized_operator,
        normalized_operator,
    )

    if operator_value not in {
        ">",
        ">=",
        "<",
        "<=",
        "=",
    }:
        operator_value = ">"

    return (
        "IFERROR("
        f'VALUE(SUBSTITUTE(SUBSTITUTE({cell_reference},"$",""),",",""))'
        ")"
        f"{operator_value}{threshold}"
    )


# ============================================================
# Excel workbook writer
# ============================================================

def _write_excel_workbook(
    df: pd.DataFrame,
    split_sheet_by: Optional[str] = None,
    original_df: Optional[pd.DataFrame] = None,
    sort_receivables_payables: bool = False,
    sort_sheet_by: Optional[str] = None,
    sort_order: Optional[str] = None,
    color_code_column: Optional[str] = None,
    color_code_operator: Optional[str] = None,
    color_code_threshold: Optional[float] = None,
    color_code_hex: Optional[str] = None,
    primary_sheet_name: str = "Report",
) -> bytes:

    logger.info(
        "attachment_pydantic: writing workbook "
        "result_summary=%s split_sheet_by=%s "
        "original_summary=%s "
        "sort_receivables_payables=%s "
        "sort_sheet_by=%s sort_order=%s "
        "color_code_column=%s "
        "color_code_operator=%s "
        "color_code_threshold=%s "
        "color_code_hex=%s",
        _dataframe_log_summary(df),
        split_sheet_by,
        (
            _dataframe_log_summary(original_df)
            if original_df is not None
            else None
        ),
        sort_receivables_payables,
        sort_sheet_by,
        sort_order,
        color_code_column,
        color_code_operator,
        color_code_threshold,
        color_code_hex,
    )

    output = BytesIO()

    with pd.ExcelWriter(
        output,
        engine="xlsxwriter",
    ) as writer:

        workbook = writer.book

        header_format = workbook.add_format(
            {
                "bold": True,
                "font_color": "white",
                "bg_color": "#4472C4",
            }
        )

        pink_format = workbook.add_format(
            {
                "bg_color": "#F4CCCC",
            }
        )

        nude_format = workbook.add_format(
            {
                "bg_color": "#FCE4D6",
            }
        )
        accounting_amount_format = workbook.add_format(
            {
                "num_format": '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)',
            }
        )

        def write_sheet(
            sheet_name: str,
            sheet_df: pd.DataFrame,
        ) -> None:

            logger.info(
                "attachment_pydantic: preparing "
                "sheet=%s rows=%d columns=%s",
                sheet_name,
                len(sheet_df),
                list(sheet_df.columns),
            )

            # =================================================
            # SORT
            # =================================================

            if sort_receivables_payables:

                sheet_df = (
                    _sort_receivables_payables_sheet(
                        sheet_df
                    )
                )

            elif sort_sheet_by:

                sheet_df = _sort_sheet_by_column(
                    sheet_df,
                    sort_sheet_by,
                    sort_order,
                )

            clean_df = sheet_df.fillna("")

            # =================================================
            # WRITE
            # =================================================

            clean_df.to_excel(
                writer,
                sheet_name=sheet_name,
                index=False,
            )

            worksheet = writer.sheets[
                sheet_name
            ]

            # Freeze header
            worksheet.freeze_panes(
                1,
                0,
            )

            # Header format
            worksheet.set_row(
                0,
                None,
                header_format,
            )

            # =================================================
            # AUTOFILTER
            # =================================================

            if len(clean_df.columns) > 0:

                worksheet.autofilter(
                    0,
                    0,
                    len(clean_df),
                    len(clean_df.columns) - 1,
                )

                logger.info(
                    "attachment_pydantic: enabled "
                    "autofilter sheet=%s rows=%d columns=%d",
                    sheet_name,
                    len(clean_df),
                    len(clean_df.columns),
                )

            # =================================================
            # RECEIVABLE COLOR CODING
            #
            # days_overdue > 0 and >= 1M = PINK
            # days_overdue > 0 and < 1M  = NUDE
            # =================================================

            if (
                sort_receivables_payables
                and len(clean_df) > 0
                and len(clean_df.columns) > 0
            ):

                days_col = _find_report_column(
                    clean_df,
                    {
                        "daysoverdue",
                        "overduedays",
                        "daysdue",
                        "duedays",
                        "agingdays",
                        "age",
                    },
                )

                amount_col = _find_report_column(
                    clean_df,
                    {
                        "invoiceamount",
                        "invoiceamt",
                        "originvamt",
                        "originalinvamt",
                        "origamount",
                        "amount",
                        "invoicevalue",
                        "totalinvoiceamount",
                        "balance",
                        "origbalance",
                        "originalbalance",
                        "outstandingamount",
                        "dueamount",
                        "invamt",
                        "amt",
                    },
                )

                if amount_col and days_col:

                    amount_idx = (
                        list(clean_df.columns)
                        .index(amount_col)
                    )
                    days_idx = (
                        list(clean_df.columns)
                        .index(days_col)
                    )

                    amount_letter = (
                        _excel_col_name(
                            amount_idx
                        )
                    )
                    days_letter = (
                        _excel_col_name(
                            days_idx
                        )
                    )

                    amount_value_formula = (
                        "IFERROR("
                        "VALUE("
                        "SUBSTITUTE("
                        "SUBSTITUTE("
                        f"${amount_letter}2,"
                        '"$",""'
                        "),"
                        '",",""'
                        ")"
                        "),0)"
                    )
                    days_value_formula = (
                        "IFERROR("
                        "VALUE("
                        "SUBSTITUTE("
                        "SUBSTITUTE("
                        f"${days_letter}2,"
                        '"$",""'
                        "),"
                        '",",""'
                        ")"
                        "),0)"
                    )

                    data_range = (
                        "A2:"
                        f"{_excel_col_name(len(clean_df.columns) - 1)}"
                        f"{len(clean_df) + 1}"
                    )

                    # -----------------------------
                    # PINK: Amount >= 1,000,000
                    # -----------------------------

                    worksheet.conditional_format(
                        data_range,
                        {
                            "type": "formula",
                            "criteria": (
                                f"=AND({days_value_formula}>0,"
                                f"{amount_value_formula}>=1000000)"
                            ),
                            "format": pink_format,
                        },
                    )

                    # -----------------------------
                    # NUDE: Amount < 1,000,000
                    # -----------------------------

                    worksheet.conditional_format(
                        data_range,
                        {
                            "type": "formula",
                            "criteria": (
                                f'=AND('
                                f'{days_value_formula}>0,'
                                f'${amount_letter}2<>"",'
                                f'{amount_value_formula}<1000000'
                                f')'
                            ),
                            "format": nude_format,
                        },
                    )

                    logger.info(
                        "attachment_pydantic: applied "
                        "receivables color coding "
                        "sheet=%s days_col=%s amount_col=%s "
                        "range=%s "
                        "pink=days>0 and amount>=1000000 "
                        "nude=days>0 and amount<1000000",
                        sheet_name,
                        days_col,
                        amount_col,
                        data_range,
                    )

                else:

                    logger.warning(
                        "attachment_pydantic: skipped "
                        "receivables color coding "
                        "sheet=%s because days/amount "
                        "column was not found days_col=%s amount_col=%s",
                        sheet_name,
                        days_col,
                        amount_col,
                    )

            # =================================================
            # GENERIC COLOR CODING
            #
            # Only used for non-special workflows.
            # =================================================

            elif (
                color_code_column
                and len(clean_df) > 0
                and len(clean_df.columns) > 0
            ):

                resolved_color_column = (
                    _resolve_dataframe_column(
                        clean_df,
                        color_code_column,
                    )
                )

                fill_color = (
                    _normalize_excel_color(
                        color_code_hex
                    )
                )

                if (
                    resolved_color_column
                    and fill_color
                ):

                    color_idx = (
                        list(clean_df.columns)
                        .index(
                            resolved_color_column
                        )
                    )

                    color_letter = (
                        _excel_col_name(
                            color_idx
                        )
                    )

                    criteria = _comparison_formula(
                        f"${color_letter}2",
                        color_code_operator,
                        color_code_threshold,
                    )

                    if criteria:

                        data_range = (
                            "A2:"
                            f"{_excel_col_name(len(clean_df.columns) - 1)}"
                            f"{len(clean_df) + 1}"
                        )

                        custom_color_format = (
                            workbook.add_format(
                                {
                                    "bg_color": fill_color
                                }
                            )
                        )

                        worksheet.conditional_format(
                            data_range,
                            {
                                "type": "formula",
                                "criteria": f"={criteria}",
                                "format": custom_color_format,
                            },
                        )

                        logger.info(
                            "attachment_pydantic: applied "
                            "custom color coding "
                            "sheet=%s column=%s "
                            "operator=%s threshold=%s "
                            "color=%s range=%s",
                            sheet_name,
                            resolved_color_column,
                            color_code_operator,
                            color_code_threshold,
                            fill_color,
                            data_range,
                        )

            # =================================================
            # ACCOUNTING FORMAT FOR AMOUNT COLUMN
            #
            # Apply this only while writing the workbook. This
            # keeps dataframe sorting/splitting/color logic intact.
            # =================================================

            amount_columns_for_format = _find_report_columns(
                clean_df,
                {
                    "invoiceamount",
                    "invoiceamt",
                    "originvamt",
                    "originalinvamt",
                    "origamount",
                    "amount",
                    "origpayorreceipt",
                    "originalpayorreceipt",
                    "paymentorreceipt",
                    "payorreceipt",
                    "invoicevalue",
                    "totalinvoiceamount",
                    "balance",
                    "origbalance",
                    "originalbalance",
                    "functbal",
                    "functionalbalance",
                    "outstandingamount",
                    "dueamount",
                    "invamt",
                    "amt",
                },
            )

            if amount_columns_for_format and len(clean_df) > 0:

                for amount_col_for_format in amount_columns_for_format:

                    amount_format_idx = (
                        list(clean_df.columns)
                        .index(amount_col_for_format)
                    )

                    formatted_values = _coerce_report_numeric(
                        clean_df[amount_col_for_format]
                    )

                    for row_offset, numeric_value in enumerate(
                        formatted_values,
                        start=1,
                    ):

                        if pd.notna(numeric_value):
                            worksheet.write_number(
                                row_offset,
                                amount_format_idx,
                                float(numeric_value),
                                accounting_amount_format,
                            )

                logger.info(
                    "attachment_pydantic: applied accounting "
                    "numbers format sheet=%s amount_cols=%s",
                    sheet_name,
                    amount_columns_for_format,
                )

            # =================================================
            # COLUMN WIDTH
            # =================================================

            for idx, column in enumerate(
                clean_df.columns
            ):

                values = (
                    clean_df[column]
                    .astype(str)
                )

                max_width = max(
                    [
                        len(str(column)),
                        *values.map(len).tolist(),
                    ]
                )

                column_width = min(
                    max(
                        max_width + 2,
                        10,
                    ),
                    60,
                )

                if column in amount_columns_for_format:
                    worksheet.set_column(
                        idx,
                        idx,
                        column_width,
                        accounting_amount_format,
                    )
                else:
                    worksheet.set_column(
                        idx,
                        idx,
                        column_width,
                    )

        # =====================================================
        # CREATE SHEETS
        # =====================================================

        if (
            split_sheet_by
            and split_sheet_by in df.columns
        ):

            logger.info(
                "attachment_pydantic: splitting "
                "workbook by column=%s",
                split_sheet_by,
            )

            sheet_frames = [
                (value, sheet_df)
                for value, sheet_df in df.groupby(
                    split_sheet_by,
                    dropna=False,
                    sort=True,
                )
            ]

        else:

            logger.info(
                "attachment_pydantic: no valid "
                "split column, writing single Report sheet"
            )

            sheet_frames = [
                (primary_sheet_name, df)
            ]

        logger.info(
            "attachment_pydantic: "
            "workbook sheet_count_before_original=%d",
            len(sheet_frames),
        )

        used_names: set[str] = set()

        # =====================================================
        # BUYER / SPLIT SHEETS
        # =====================================================

        for sheet_value, sheet_df in sheet_frames:

            sheet_name = _safe_excel_sheet_name(
                sheet_value,
                used_names,
            )

            write_sheet(
                sheet_name,
                sheet_df,
            )

        # =====================================================
        # ORIGINAL DATA
        # =====================================================

        if original_df is not None:

            original_sheet_name = (
                _safe_excel_sheet_name(
                    "original_data",
                    used_names,
                )
            )

            logger.info(
                "attachment_pydantic: adding "
                "original data sheet=%s",
                original_sheet_name,
            )

            write_sheet(
                original_sheet_name,
                original_df,
            )

    output.seek(0)

    content = output.read()

    logger.info(
        "attachment_pydantic: workbook bytes=%d",
        len(content),
    )

    return content


# ============================================================
# Filename helper
# ============================================================

def _safe_attachment_filename(
    value: Optional[str],
    default: str,
) -> str:

    candidate = str(
        value or default
    ).strip()

    if not candidate.lower().endswith(
        ".xlsx"
    ):
        candidate = (
            f"{candidate}.xlsx"
        )

    stem, suffix = os.path.splitext(
        candidate
    )

    stem = re.sub(
        r"[^A-Za-z0-9._-]+",
        "_",
        stem,
    ).strip("._-") or default

    return (
        f"{stem}"
        f"{suffix or '.xlsx'}"
    )


def _safe_filename_part(value: Any) -> str:
    if value is None or (
        not isinstance(value, str)
        and pd.isna(value)
    ):
        value = "blank"

    cleaned = re.sub(
        r"[^A-Za-z0-9._-]+",
        "_",
        str(value).strip(),
    ).strip("._-")

    return cleaned[:80] or "blank"


def _split_workbook_filename(
    base_filename: str,
    split_value: Any,
) -> str:
    base_filename = _safe_attachment_filename(
        base_filename,
        "processed_attachment.xlsx",
    )

    stem, suffix = os.path.splitext(
        base_filename
    )

    return _safe_attachment_filename(
        (
            f"{stem}_"
            f"{_safe_filename_part(split_value)}"
            f"{suffix or '.xlsx'}"
        ),
        (
            "processed_attachment_"
            f"{_safe_filename_part(split_value)}.xlsx"
        ),
    )


# ============================================================
# MAIN PROCESSING FUNCTION
# ============================================================

def process_attachment_pydantic_operations(
    query: str,
    dataframe: pd.DataFrame,
    llm,
    datamart_context: Any = "",
    default_filename: str = "processed_attachment.xlsx",
    sort_receivables_payables: bool = False,
) -> Optional[Dict[str, Any]]:

    logger.info(
        "attachment_pydantic: start "
        "query=%s dataframe_summary=%s "
        "datamart_context=%s "
        "default_filename=%s "
        "sort_receivables_payables=%s",
        _truncate_log_value(query),
        _dataframe_log_summary(dataframe),
        _truncate_log_value(datamart_context),
        default_filename,
        sort_receivables_payables,
    )

    # =========================================================
    # EMPTY DATAFRAME
    # =========================================================

    if (
        dataframe is None
        or dataframe.empty
    ):

        logger.info(
            "attachment_pydantic: skipped "
            "because dataframe is none/empty"
        )

        return None

    # =========================================================
    # AUTOMATICALLY DETECT RECEIVABLE WORKFLOW
    # =========================================================

    is_receivables_workflow = (
        sort_receivables_payables
        or _is_receivables_payables_workflow(
            query,
            dataframe,
        )
    )

    logger.info(
        "attachment_pydantic: final "
        "receivables_payables_mode=%s",
        is_receivables_workflow,
    )

    # =========================================================
    # BUILD LLM PROMPT
    # =========================================================

    prompt = _build_attachment_operation_prompt(
        query=query,
        df=dataframe,
        datamart_context=datamart_context,
    )

    logger.info(
        "attachment_pydantic: prompt_schema=%s",
        _schema_for_prompt(dataframe),
    )

    # =========================================================
    # LLM CALL
    # =========================================================

    response = llm.invoke(prompt)

    llm_response = (
        response.content
        if hasattr(response, "content")
        else response
    )

    logger.info(
        "attachment_pydantic: raw_llm_response=%s",
        _truncate_log_value(
            llm_response,
            2000,
        ),
    )

    # =========================================================
    # PARSE JSON
    # =========================================================

    operation = AttachmentPandasOperation(
        **json.loads(
            _strip_json_markdown(
                llm_response or ""
            )
        )
    )

    operation_payload = (
        operation.model_dump()
        if hasattr(
            operation,
            "model_dump",
        )
        else operation.dict()
    )

    logger.info(
        "attachment_pydantic: parsed_operation=%s",
        operation_payload,
    )

    # =========================================================
    # NO OPERATION
    # =========================================================

    if not operation.operation_required:

        logger.info(
            "attachment_pydantic: "
            "operation_required=false, "
            "returning no attachment"
        )

        return None

    # =========================================================
    # EXECUTE LLM PANDAS CODE
    # =========================================================

    try:

        raw_result = _execute_pandas_code(
            operation.code,
            dataframe,
        )

    except Exception:

        logger.exception(
            "attachment_pydantic: generated "
            "pandas code failed "
            "operation=%s dataframe_summary=%s",
            operation_payload,
            _dataframe_log_summary(
                dataframe
            ),
        )

        raise

    # =========================================================
    # NORMALIZE RESULT TO DATAFRAME
    # =========================================================

    if isinstance(
        raw_result,
        pd.Series,
    ):

        result_df = (
            raw_result
            .to_frame()
            .reset_index()
        )

    elif isinstance(
        raw_result,
        pd.DataFrame,
    ):

        result_df = raw_result

    elif isinstance(
        raw_result,
        list,
    ):

        result_df = pd.DataFrame(
            raw_result
        )

    elif isinstance(
        raw_result,
        dict,
    ):

        result_df = pd.DataFrame(
            [raw_result]
        )

    else:

        result_df = pd.DataFrame(
            {
                "result": [
                    raw_result
                ]
            }
        )

    logger.info(
        "attachment_pydantic: result_summary=%s",
        _dataframe_log_summary(
            result_df
        ),
    )

    # =========================================================
    # RESOLVE SPLIT COLUMN
    # =========================================================

    split_sheet_by = (
        operation.split_sheet_by
    )

    if split_sheet_by:

        resolved_split_col = (
            _resolve_dataframe_column(
                result_df,
                split_sheet_by,
            )
        )

        if resolved_split_col:

            split_sheet_by = (
                resolved_split_col
            )

    if (
        split_sheet_by
        and split_sheet_by
        not in result_df.columns
    ):

        logger.warning(
            "attachment_pydantic: requested "
            "split_sheet_by=%s not present "
            "in result columns=%s; "
            "disabling split",
            split_sheet_by,
            list(result_df.columns),
        )

        split_sheet_by = None

    logger.info(
        "attachment_pydantic: final "
        "split_sheet_by=%s",
        split_sheet_by,
    )

    separate_workbook_split_requested = (
        _looks_like_separate_workbook_split_request(
            query
        )
    )

    # =========================================================
    # RESOLVE SPLIT WORKBOOK COLUMN
    # =========================================================

    split_workbook_by = (
        operation.split_workbook_by
    )

    if (
        separate_workbook_split_requested
        and not split_workbook_by
        and split_sheet_by
    ):

        logger.info(
            "attachment_pydantic: promoting split_sheet_by=%s "
            "to split_workbook_by because user requested "
            "separate workbook files",
            split_sheet_by,
        )

        split_workbook_by = split_sheet_by
        split_sheet_by = None

    if split_workbook_by:

        resolved_workbook_split_col = (
            _resolve_dataframe_column(
                result_df,
                split_workbook_by,
            )
        )

        if resolved_workbook_split_col:

            split_workbook_by = (
                resolved_workbook_split_col
            )

    if (
        split_workbook_by
        and split_workbook_by
        not in result_df.columns
    ):

        logger.warning(
            "attachment_pydantic: requested "
            "split_workbook_by=%s not present "
            "in result columns=%s; "
            "disabling workbook split",
            split_workbook_by,
            list(result_df.columns),
        )

        split_workbook_by = None

    if split_workbook_by and split_sheet_by:

        logger.info(
            "attachment_pydantic: both split_workbook_by=%s "
            "and split_sheet_by=%s were requested; "
            "separate workbook split takes precedence",
            split_workbook_by,
            split_sheet_by,
        )

        split_sheet_by = None

    logger.info(
        "attachment_pydantic: final "
        "split_workbook_by=%s",
        split_workbook_by,
    )

    # =========================================================
    # RESOLVE GENERIC SORT COLUMN
    #
    # Disable generic sort for special receivables workflow.
    # =========================================================

    sort_sheet_by = (
        operation.sort_sheet_by
    )

    sort_order = (
        operation.sort_order
    )

    if is_receivables_workflow:

        sort_sheet_by = None
        sort_order = None

        logger.info(
            "attachment_pydantic: special "
            "receivables/payables workflow "
            "detected; disabling generic "
            "sheet sort",
        )

    elif sort_sheet_by:

        result_sort_col = (
            _resolve_dataframe_column(
                result_df,
                sort_sheet_by,
            )
        )

        original_sort_col = (
            _resolve_dataframe_column(
                dataframe,
                sort_sheet_by,
            )
        )

        if result_sort_col:

            sort_sheet_by = (
                result_sort_col
            )

        elif original_sort_col:

            sort_sheet_by = (
                original_sort_col
            )

        else:

            logger.warning(
                "attachment_pydantic: requested "
                "sort_sheet_by=%s not present "
                "in result/original columns; "
                "disabling sheet sort",
                sort_sheet_by,
            )

            sort_sheet_by = None
            sort_order = None

    logger.info(
        "attachment_pydantic: final sheet sort "
        "sort_sheet_by=%s sort_order=%s",
        sort_sheet_by,
        sort_order,
    )

    # =========================================================
    # COLOR CODE
    #
    # Special receivable workflow uses deterministic
    # pink/nude coloring.
    # =========================================================

    color_code_column = (
        operation.color_code_column
    )

    if is_receivables_workflow:

        # Special workflow handles both colors itself.
        color_code_column = None

        logger.info(
            "attachment_pydantic: special "
            "receivables/payables workflow "
            "uses deterministic color coding",
        )

    elif color_code_column:

        result_color_col = (
            _resolve_dataframe_column(
                result_df,
                color_code_column,
            )
        )

        original_color_col = (
            _resolve_dataframe_column(
                dataframe,
                color_code_column,
            )
        )

        if result_color_col:

            color_code_column = (
                result_color_col
            )

        elif original_color_col:

            color_code_column = (
                original_color_col
            )

        else:

            logger.warning(
                "attachment_pydantic: requested "
                "color_code_column=%s not present "
                "in result/original columns; "
                "disabling custom color coding",
                color_code_column,
            )

            color_code_column = None

    logger.info(
        "attachment_pydantic: final custom "
        "color color_code_column=%s "
        "operator=%s threshold=%s color=%s",
        color_code_column,
        operation.color_code_operator,
        operation.color_code_threshold,
        operation.color_code_hex,
    )

    # =========================================================
    # WRITE WORKBOOK
    # =========================================================

    output_filename = _safe_attachment_filename(
        operation.output_filename,
        default_filename,
    )

    if split_workbook_by:

        attachments = []

        for split_value, workbook_df in result_df.groupby(
            split_workbook_by,
            dropna=False,
            sort=True,
        ):

            workbook_content = _write_excel_workbook(
                workbook_df,
                split_sheet_by=None,
                original_df=None,
                sort_receivables_payables=(
                    is_receivables_workflow
                ),
                sort_sheet_by=sort_sheet_by,
                sort_order=sort_order,
                color_code_column=color_code_column,
                color_code_operator=(
                    operation.color_code_operator
                ),
                color_code_threshold=(
                    operation.color_code_threshold
                ),
                color_code_hex=(
                    operation.color_code_hex
                ),
            )

            attachments.append(
                {
                    "content": workbook_content,
                    "maintype": "application",
                    "subtype": (
                        "vnd.openxmlformats-officedocument."
                        "spreadsheetml.sheet"
                    ),
                    "filename": _split_workbook_filename(
                        output_filename,
                        split_value,
                    ),
                }
            )

        original_workbook_content = _write_excel_workbook(
            dataframe,
            split_sheet_by=None,
            original_df=None,
            sort_receivables_payables=(
                is_receivables_workflow
            ),
            sort_sheet_by=sort_sheet_by,
            sort_order=sort_order,
            color_code_column=color_code_column,
            color_code_operator=(
                operation.color_code_operator
            ),
            color_code_threshold=(
                operation.color_code_threshold
            ),
            color_code_hex=(
                operation.color_code_hex
            ),
            primary_sheet_name="original_data",
        )

        attachments.append(
            {
                "content": original_workbook_content,
                "maintype": "application",
                "subtype": (
                    "vnd.openxmlformats-officedocument."
                    "spreadsheetml.sheet"
                ),
                "filename": _safe_attachment_filename(
                    "original_data.xlsx",
                    "original_data.xlsx",
                ),
            }
        )

        logger.info(
            "attachment_pydantic: created split workbook "
            "attachments count=%d split_workbook_by=%s",
            len(attachments),
            split_workbook_by,
        )

        return {
            "attachments": attachments,

            "filename": output_filename,

            "operation": operation_payload,

            "receivables_payables_workflow": (
                is_receivables_workflow
            ),

            "split_sheet_by": None,

            "split_workbook_by": split_workbook_by,

            "sort_sheet_by": sort_sheet_by,

            "sort_order": sort_order,
        }

    workbook_content = _write_excel_workbook(
        result_df,
        split_sheet_by=split_sheet_by,
        original_df=dataframe,
        sort_receivables_payables=(
            is_receivables_workflow
        ),
        sort_sheet_by=sort_sheet_by,
        sort_order=sort_order,
        color_code_column=color_code_column,
        color_code_operator=(
            operation.color_code_operator
        ),
        color_code_threshold=(
            operation.color_code_threshold
        ),
        color_code_hex=(
            operation.color_code_hex
        ),
    )

    # =========================================================
    # FINAL RESPONSE
    # =========================================================

    return {
        "content": workbook_content,

        "maintype": "application",

        "subtype": (
            "vnd.openxmlformats-officedocument."
            "spreadsheetml.sheet"
        ),

        "filename": output_filename,

        "operation": operation_payload,

        # Useful for debugging
        "receivables_payables_workflow": (
            is_receivables_workflow
        ),

        "split_sheet_by": split_sheet_by,

        "split_workbook_by": split_workbook_by,

        "sort_sheet_by": sort_sheet_by,

        "sort_order": sort_order,
    }
