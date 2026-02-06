import { twMerge } from "tailwind-merge";

type Variant = "primary" | "secondary" | "passive" | "danger" | "outline";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: Variant;
}

const variants: Record<Variant, string> = {
	primary: "bg-primary text-primary-foreground hover:shadow-[var(--shadow-btn-primary)] transition-shadow",
    secondary: "bg-transparent text-foreground hover:bg-muted-foreground transition-colors",
    passive: "bg-foreground text-background hover:shadow-[var(--shadow-btn-primary)] transition-shadow",
    danger: "bg-negative text-negative-foreground hover:brightness-100 transition-all",
    outline: "border border-muted text-foreground hover:bg-muted transition-colors",
};

export function Button({
	variant = "primary",
	className,
	...props
}: ButtonProps) {
	return (
		<button
			className={twMerge(
				"px-4 py-2 rounded font-medium",
				variants[variant],
				className,
			)}
			{...props}
		/>
	);
}
