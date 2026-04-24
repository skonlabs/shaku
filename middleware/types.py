"""Shared data types for the token-optimization middleware."""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Literal, Optional


class TaskType(str, Enum):
    CLASSIFICATION = "classification"
    EXTRACTION = "extraction"
    SUMMARIZATION = "summarization"
    GENERATION = "generation"
    REASONING = "reasoning"
    CODING = "coding"


class Provider(str, Enum):
    OPENAI = "openai"
    ANTHROPIC = "anthropic"


@dataclass
class Message:
    role: Literal["system", "user", "assistant"]
    content: str

    def to_dict(self) -> Dict[str, str]:
        return {"role": self.role, "content": self.content}

    @staticmethod
    def from_dict(d: Dict[str, Any]) -> "Message":
        role = d.get("role", "user")
        content = d.get("content", "")
        if not isinstance(content, str):
            # Flatten list content (e.g. Anthropic vision blocks) to text
            if isinstance(content, list):
                parts = []
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        parts.append(block.get("text", ""))
                content = " ".join(parts)
            else:
                content = str(content)
        return Message(role=role, content=content)  # type: ignore[arg-type]


@dataclass
class TokenBudget:
    max_input_tokens: int = 8_000
    max_output_tokens: int = 2_048
    max_total_tokens: int = 10_048


@dataclass
class OptimizationConfig:
    budget: TokenBudget = field(default_factory=TokenBudget)
    history_keep_turns: int = 10
    context_top_k_chunks: int = 5
    chunk_size_tokens: int = 512
    chunk_overlap_tokens: int = 64
    enable_cleaning: bool = True
    enable_normalization: bool = True
    enable_history_trimming: bool = True
    enable_context_pruning: bool = True
    enable_caching: bool = True
    task_type: Optional[TaskType] = None
    provider: Provider = Provider.OPENAI
    # Domains where aggressive compression must not be applied
    sensitive_domains: List[str] = field(
        default_factory=lambda: ["legal", "medical", "financial", "compliance"]
    )
    model: str = "gpt-4o"


@dataclass
class OptimizationResult:
    messages: List[Message]
    system_prompt: Optional[str]
    max_output_tokens: int
    input_tokens_before: int
    input_tokens_after: int
    warnings: List[str]
    cache_hits: int

    @property
    def savings_tokens(self) -> int:
        return max(0, self.input_tokens_before - self.input_tokens_after)

    @property
    def savings_pct(self) -> float:
        if self.input_tokens_before == 0:
            return 0.0
        return round(self.savings_tokens / self.input_tokens_before * 100, 2)
