export default function PageHeader({ title, subtitle }) {
  return (
    <div className="mb-4">
      <h1 className="text-xl font-bold text-stone-800 leading-tight">{title}</h1>
      {subtitle && (
        <p className="text-sm text-stone-500 mt-0.5">{subtitle}</p>
      )}
    </div>
  );
}
